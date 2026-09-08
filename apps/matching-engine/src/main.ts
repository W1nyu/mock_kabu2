import "./env";
import { getPrisma } from "@mock-kabu/db";
import {
  CONSUMER_GROUPS,
  KEYS,
  STREAM_RETENTION,
  STREAMS,
  WORKERS,
  trimAcknowledgedStream,
  type OrderStreamEvent,
} from "@mock-kabu/shared";
import Redis from "ioredis";
import { MatchingEngine } from "./engine";
import { RedisLeaderLease } from "./leader-lease";
import { parseOrderStreamMessages, type StreamReply } from "./stream-parser";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:56379";
const GROUP = CONSUMER_GROUPS.MATCHING;
const CONSUMER = `engine-${process.pid}`;

type StreamMessages = [id: string, fields: string[]][];
type AutoClaimReply = [nextId: string, messages: StreamMessages, deletedIds: string[]];

const CLAIM_IDLE_MS = 30_000;
const CLAIM_INTERVAL_MS = 5_000;
const HEARTBEAT_INTERVAL_MS = 5_000;
const HEARTBEAT_TTL_SECONDS = 15;
const WORKER_NAME = WORKERS.MATCHING_ENGINE;
// A longer TTL than the five-second blocking read gives the active process
// headroom for a brief GC pause while renewal still runs every five seconds.
const LEADER_LEASE_TTL_MS = 30_000;
const LEADER_RENEW_INTERVAL_MS = 5_000;
const STANDBY_RETRY_MS = 1_000;

const PUBLISH_HEARTBEAT_IF_LEADER = `
  if redis.call("GET", KEYS[1]) ~= ARGV[1] then
    return 0
  end
  redis.call("SET", KEYS[2], ARGV[2], "EX", ARGV[3])
  return 1
`;

const CLEAR_HEARTBEAT_IF_LEADER = `
  if redis.call("GET", KEYS[1]) ~= ARGV[1] then
    return 0
  end
  return redis.call("DEL", KEYS[2])
`;

async function processMessages(
  stream: Redis,
  engine: MatchingEngine,
  messages: { id: string; ev: OrderStreamEvent }[],
  recovering = false,
  canProcess = () => true,
) {
  for (const { id, ev } of messages) {
    if (!canProcess()) return;
    try {
      await engine.handleEvent(ev, { recovery: recovering });
      // If leadership changed while the durable event was being handled, do
      // not ACK it. The new leader will replay it idempotently from the PEL.
      if (!canProcess()) return;
      await stream.xack(STREAMS.ORDERS, GROUP, id);
    } catch (e) {
      // DB/Redis 실패는 ACK하지 않는다. 다음 XAUTOCLAIM이 동일 eventId를 다시
      // 전달하고, engine의 durable claim이 중복 체결 없이 안전하게 재시도한다.
      console.error(`[engine] event failed (retained for retry) ${ev.eventId}`, e);
    }
  }
}

async function reclaimPending(stream: Redis, consumer: string, cursor: string) {
  const reply = (await stream.xautoclaim(
    STREAMS.ORDERS,
    GROUP,
    consumer,
    CLAIM_IDLE_MS,
    cursor,
    "COUNT",
    100,
  )) as unknown as AutoClaimReply;
  return { nextCursor: reply?.[0] ?? "0-0", messages: reply?.[1] ?? [] };
}

async function publishHeartbeat(
  redis: Redis,
  startedAt: string,
  lease: RedisLeaderLease,
): Promise<boolean> {
  const result = await redis.eval(
    PUBLISH_HEARTBEAT_IF_LEADER,
    2,
    lease.key,
    KEYS.heartbeat(WORKER_NAME),
    lease.token,
    JSON.stringify({ pid: process.pid, startedAt, updatedAt: new Date().toISOString() }),
    String(HEARTBEAT_TTL_SECONDS),
  );
  return Number(result) === 1;
}

async function clearHeartbeat(redis: Redis, lease: RedisLeaderLease): Promise<boolean> {
  const result = await redis.eval(
    CLEAR_HEARTBEAT_IF_LEADER,
    2,
    lease.key,
    KEYS.heartbeat(WORKER_NAME),
    lease.token,
  );
  return Number(result) === 1;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForLeadership(lease: RedisLeaderLease, isStopping: () => boolean): Promise<boolean> {
  let announcedStandby = false;
  while (!isStopping()) {
    try {
      if (await lease.acquire()) {
        console.log(`[engine] leader lease acquired (${lease.key})`);
        return true;
      }
      if (!announcedStandby) {
        console.log(`[engine] standby: waiting for leader lease (${lease.key})`);
        announcedStandby = true;
      }
    } catch (error) {
      // Redis is both the stream transport and the leader authority. Starting
      // an in-memory book without it would be unsafe, so keep waiting.
      console.error("[engine] leader lease acquire failed; remaining standby", error);
    }
    await sleep(STANDBY_RETRY_MS);
  }
  return false;
}

async function main() {
  const prisma = getPrisma();
  const stream = new Redis(REDIS_URL);
  const publisher = new Redis(REDIS_URL);
  // XREADGROUP blocks `stream` for up to five seconds. Lease renewal and
  // heartbeat therefore require a separate connection so a blocked read can
  // never accidentally let an active leader's TTL expire.
  const control = new Redis(REDIS_URL, {
    // Do not queue lease commands indefinitely while Redis reconnects. A
    // leader that cannot prove ownership within one renewal window fails
    // closed rather than continuing with a potentially stale orderbook.
    commandTimeout: LEADER_RENEW_INTERVAL_MS,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
  });
  const lease = new RedisLeaderLease(control, KEYS.leaderLease(WORKER_NAME), LEADER_LEASE_TTL_MS);
  const startedAt = new Date().toISOString();
  let stopping = false;
  let leadershipLost = false;
  let snapshotTimer: NodeJS.Timeout | undefined;
  let heartbeatTimer: NodeJS.Timeout | undefined;
  let leaseRenewTimer: NodeJS.Timeout | undefined;
  let streamTrimTimer: NodeJS.Timeout | undefined;
  let renewingLease = false;
  let publishingHeartbeat = false;

  const requestShutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`[engine] ${signal} received; finishing the current event before shutdown`);
  };
  const onSigterm = () => requestShutdown("SIGTERM");
  const onSigint = () => requestShutdown("SIGINT");
  process.once("SIGTERM", onSigterm);
  process.once("SIGINT", onSigint);

  try {
    if (!(await waitForLeadership(lease, () => stopping))) return;

    const stopForLeadershipLoss = (reason: string, error?: unknown) => {
      if (stopping) return;
      leadershipLost = true;
      stopping = true;
      console.error(`[engine] leader lease lost (${reason}); stopping before another event`, error ?? "");
    };
    const renewLease = async () => {
      if (stopping || renewingLease) return;
      renewingLease = true;
      try {
        if (!(await lease.renew())) stopForLeadershipLoss("ownership changed");
      } catch (error) {
        // Treat an uncertain renewal as lost rather than continuing to write
        // from a potentially stale in-memory orderbook.
        stopForLeadershipLoss("renewal failed", error);
      } finally {
        renewingLease = false;
      }
    };
    const refreshHeartbeat = async () => {
      if (stopping || publishingHeartbeat) return;
      publishingHeartbeat = true;
      try {
        if (!(await publishHeartbeat(control, startedAt, lease))) {
          stopForLeadershipLoss("heartbeat ownership check failed");
        }
      } catch (error) {
        stopForLeadershipLoss("heartbeat publish failed", error);
      } finally {
        publishingHeartbeat = false;
      }
    };

    leaseRenewTimer = setInterval(() => void renewLease(), LEADER_RENEW_INTERVAL_MS);
    await refreshHeartbeat();
    if (stopping) return;

    const engine = new MatchingEngine(prisma, stream, publisher);
    await engine.bootstrap();
    if (stopping || !lease.isHeld) return;
    await engine.flushSettlementOutbox().catch((e) =>
      console.error("[engine] settlement outbox bootstrap relay", e),
    );

    try {
      await stream.xgroup("CREATE", STREAMS.ORDERS, GROUP, "0", "MKSTREAM");
    } catch (e) {
      if (!String(e).includes("BUSYGROUP")) throw e;
    }

    // Order data is durable in PostgreSQL's transactional outbox. Redis keeps
    // only the unacknowledged transport tail, bounded by the oldest PEL entry,
    // so a busy bot market cannot grow the stream and Redis RSS forever.
    const trimAcknowledgedOrders = () => {
      if (stopping || !lease.isHeld) return;
      void trimAcknowledgedStream(control, STREAMS.ORDERS, GROUP).catch((error) =>
        console.warn("[engine] acknowledged order stream trim deferred", error),
      );
    };
    streamTrimTimer = setInterval(trimAcknowledgedOrders, STREAM_RETENTION.TRIM_INTERVAL_MS);
    trimAcknowledgedOrders();

    // 1) 늦게 구독한 클라이언트를 위한 주기적 스냅샷 재발행
    snapshotTimer = setInterval(() => {
      if (stopping) return;
      engine.flushSettlementOutbox().catch((e) => console.error("[engine] settlement outbox relay", e));
      engine.publishAllSnapshots().catch((e) => console.error("[engine] snapshot publish", e));
    }, 1000);
    heartbeatTimer = setInterval(() => {
      void refreshHeartbeat();
    }, HEARTBEAT_INTERVAL_MS);

    console.log(`[engine] consuming ${STREAMS.ORDERS} as ${GROUP}/${CONSUMER}`);

    // 2) 라이브 소비 루프 — 심볼별 single-writer (스펙 3.2)
    // XREADGROUP ... 0 은 현재 consumer 자신의 pending만 읽기 때문에, 재시작으로
    // consumer 이름(PID)이 바뀐 PEL은 XAUTOCLAIM으로 회수해야 한다.
    let claimCursor = "0-0";
    let lastClaimAt = 0;
    while (!stopping) {
      if (Date.now() - lastClaimAt >= CLAIM_INTERVAL_MS) {
        try {
          const claimed = await reclaimPending(stream, CONSUMER, claimCursor);
          claimCursor = claimed.nextCursor;
          await processMessages(
            stream,
            engine,
            parseOrderStreamMessages([[STREAMS.ORDERS, claimed.messages]]),
            true,
            () => !stopping && lease.isHeld,
          );
        } catch (e) {
          if (!stopping) console.error("[engine] xautoclaim error, retrying", e);
        }
        lastClaimAt = Date.now();
      }

      let reply: StreamReply = null;
      try {
        reply = (await stream.xreadgroup(
          "GROUP", GROUP, CONSUMER,
          "COUNT", 100,
          "BLOCK", 5000,
          "STREAMS", STREAMS.ORDERS, ">",
        )) as StreamReply;
      } catch (e) {
        if (stopping) break;
        console.error("[engine] xreadgroup error, retrying", e);
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }

      if (!stopping) {
        await processMessages(
          stream,
          engine,
          parseOrderStreamMessages(reply),
          false,
          () => !stopping && lease.isHeld,
        );
      }
    }
  } finally {
    if (snapshotTimer) clearInterval(snapshotTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (leaseRenewTimer) clearInterval(leaseRenewTimer);
    if (streamTrimTimer) clearInterval(streamTrimTimer);
    process.off("SIGTERM", onSigterm);
    process.off("SIGINT", onSigint);
    // A predecessor must never delete a heartbeat a successor has already
    // written after a lease handoff, so clear it only while our token owns the
    // leader key. Otherwise its short TTL expires naturally.
    await clearHeartbeat(control, lease).catch((error) => {
      if (!leadershipLost) console.warn("[engine] heartbeat clear failed", error);
    });
    await lease.release().catch((error) => {
      if (!leadershipLost) console.warn("[engine] leader lease release failed", error);
    });
    await Promise.allSettled([stream.quit(), publisher.quit(), control.quit(), prisma.$disconnect()]);
    // A supervisor should replace an unexpectedly stale leader. A deliberate
    // SIGTERM remains a clean exit and lets its standby take over normally.
    if (leadershipLost) process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error("[engine] fatal", e);
  process.exitCode = 1;
});
