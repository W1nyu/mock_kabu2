import "./env";
import { getPrisma } from "@mock-kabu/db";
import { CONSUMER_GROUPS, STREAMS, type OrderStreamEvent } from "@mock-kabu/shared";
import Redis from "ioredis";
import { MatchingEngine } from "./engine";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:56379";
const GROUP = CONSUMER_GROUPS.MATCHING;
const CONSUMER = `engine-${process.pid}`;

type StreamReply = [key: string, messages: [id: string, fields: string[]][]][] | null;
type StreamMessages = [id: string, fields: string[]][];
type AutoClaimReply = [nextId: string, messages: StreamMessages, deletedIds: string[]];

const CLAIM_IDLE_MS = 30_000;
const CLAIM_INTERVAL_MS = 5_000;

function parseMessages(reply: StreamReply): { id: string; ev: OrderStreamEvent }[] {
  if (!reply) return [];
  const out: { id: string; ev: OrderStreamEvent }[] = [];
  for (const [, messages] of reply) {
    for (const [id, fields] of messages) {
      const idx = fields.indexOf("payload");
      if (idx >= 0) {
        out.push({ id, ev: JSON.parse(fields[idx + 1]) });
      }
    }
  }
  return out;
}

async function processMessages(
  stream: Redis,
  engine: MatchingEngine,
  messages: { id: string; ev: OrderStreamEvent }[],
) {
  for (const { id, ev } of messages) {
    try {
      await engine.handleEvent(ev);
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

async function main() {
  const prisma = getPrisma();
  const stream = new Redis(REDIS_URL);
  const publisher = new Redis(REDIS_URL);

  const engine = new MatchingEngine(prisma, stream, publisher);
  await engine.bootstrap();
  await engine.flushSettlementOutbox().catch((e) =>
    console.error("[engine] settlement outbox bootstrap relay", e),
  );

  try {
    await stream.xgroup("CREATE", STREAMS.ORDERS, GROUP, "0", "MKSTREAM");
  } catch (e) {
    if (!String(e).includes("BUSYGROUP")) throw e;
  }

  // 1) 늦게 구독한 클라이언트를 위한 주기적 스냅샷 재발행
  setInterval(() => {
    engine.flushSettlementOutbox().catch((e) => console.error("[engine] settlement outbox relay", e));
    engine.publishAllSnapshots().catch((e) => console.error("[engine] snapshot publish", e));
  }, 1000);

  console.log(`[engine] consuming ${STREAMS.ORDERS} as ${GROUP}/${CONSUMER}`);

  // 2) 라이브 소비 루프 — 심볼별 single-writer (스펙 3.2)
  // XREADGROUP ... 0 은 현재 consumer 자신의 pending만 읽기 때문에, 재시작으로
  // consumer 이름(PID)이 바뀐 PEL은 XAUTOCLAIM으로 회수해야 한다.
  let claimCursor = "0-0";
  let lastClaimAt = 0;
  while (true) {
    if (Date.now() - lastClaimAt >= CLAIM_INTERVAL_MS) {
      try {
        const claimed = await reclaimPending(stream, CONSUMER, claimCursor);
        claimCursor = claimed.nextCursor;
        await processMessages(stream, engine, parseMessages([[STREAMS.ORDERS, claimed.messages]]));
      } catch (e) {
        console.error("[engine] xautoclaim error, retrying", e);
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
      console.error("[engine] xreadgroup error, retrying", e);
      await new Promise((r) => setTimeout(r, 1000));
      continue;
    }

    await processMessages(stream, engine, parseMessages(reply));
  }
}

main().catch((e) => {
  console.error("[engine] fatal", e);
  process.exit(1);
});
