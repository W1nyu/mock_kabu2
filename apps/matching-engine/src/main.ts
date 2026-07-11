import "./env";
import { getPrisma } from "@mock-kabu/db";
import { CONSUMER_GROUPS, STREAMS, type OrderStreamEvent } from "@mock-kabu/shared";
import Redis from "ioredis";
import { MatchingEngine } from "./engine";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const GROUP = CONSUMER_GROUPS.MATCHING;
const CONSUMER = `engine-${process.pid}`;

type StreamReply = [key: string, messages: [id: string, fields: string[]][]][] | null;

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

async function main() {
  const prisma = getPrisma();
  const stream = new Redis(REDIS_URL);
  const publisher = new Redis(REDIS_URL);

  const engine = new MatchingEngine(prisma, stream, publisher);
  await engine.bootstrap();

  try {
    await stream.xgroup("CREATE", STREAMS.ORDERS, GROUP, "0", "MKSTREAM");
  } catch (e) {
    if (!String(e).includes("BUSYGROUP")) throw e;
  }

  // 1) 크래시 전 전달됐지만 ack되지 않은 메시지 재처리 (멱등 가드 적용)
  while (true) {
    const reply = (await stream.xreadgroup(
      "GROUP", GROUP, CONSUMER,
      "COUNT", 100,
      "STREAMS", STREAMS.ORDERS, "0",
    )) as StreamReply;
    const msgs = parseMessages(reply);
    if (msgs.length === 0) break;
    for (const { id, ev } of msgs) {
      try {
        await engine.handleEvent(ev, true);
      } catch (e) {
        console.error(`[engine] redelivered event failed (ack & skip) ${ev.eventId}`, e);
      }
      await stream.xack(STREAMS.ORDERS, GROUP, id);
    }
  }

  // 2) 늦게 구독한 클라이언트를 위한 주기적 스냅샷 재발행
  setInterval(() => {
    engine.publishAllSnapshots().catch((e) => console.error("[engine] snapshot publish", e));
  }, 1000);

  console.log(`[engine] consuming ${STREAMS.ORDERS} as ${GROUP}/${CONSUMER}`);

  // 3) 라이브 소비 루프 — 심볼별 single-writer (스펙 3.2)
  while (true) {
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

    for (const { id, ev } of parseMessages(reply)) {
      try {
        await engine.handleEvent(ev, false);
      } catch (e) {
        // poison 메시지로 인한 무한 재전달을 막기 위해 로그 후 ack
        console.error(`[engine] event failed (ack & skip) ${ev.eventId}`, e);
      }
      await stream.xack(STREAMS.ORDERS, GROUP, id);
    }
  }
}

main().catch((e) => {
  console.error("[engine] fatal", e);
  process.exit(1);
});
