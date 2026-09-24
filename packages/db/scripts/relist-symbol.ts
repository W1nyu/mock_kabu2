/**
 * 종목 재상장 — 시세 이력을 새로 시작한다. 원장(체결·주문·보유·실현손익·정산 claim)은 지우지 않는다.
 *
 *   pnpm --filter @mock-kabu/db relist -- --symbol KABU                 # 점검만 (dry run)
 *   pnpm --filter @mock-kabu/db relist -- --symbol KABU --cancel-orders # 1) 미체결·예약 주문 취소
 *   pnpm --filter @mock-kabu/db relist -- --symbol KABU --apply         # 2) 재상장 적용
 *
 * 재상장 가격은 기본값이 재상장 직전 현재가(종가)다 — 보유자의 평가금액이 갑자기 바뀌지 않는다.
 * 다른 가격으로 열어야 할 때만 --price를 준다.
 *
 * 순서: 봇 정지 → --cancel-orders(API·매칭·정산이 떠 있어야 함) → --apply → 매칭 엔진 재시작 → 봇 시작.
 *
 * --cancel-orders  미체결 주문은 API와 같은 outbox `order.cancel.requested` 이벤트로 취소를 요청하고
 *                  (홀드 해제는 매칭 엔진·정산이 처리), 대기 예약 주문은 API와 같이 CANCELED로 바꾼다.
 * --apply          미체결/예약 주문이 없어야 실행된다. 한 트랜잭션으로
 *                  - 현재가·상장가 = 직전 종가(또는 --price), listed_at = 지금 (이전 체결은 시세에서 제외됨)
 *                  - 지수 구간 재작성: 과거 구간에서 종목 제외, 지금부터 지수가 이어지도록 새 구간 추가
 *                  - 종목 1분봉(파생 데이터)과 종목 뉴스 삭제
 * 보유 주식(account.holdings)은 건드리지 않는다 → 기존 보유자는 같은 수량을 새 종목으로 그대로 가진다(1:1).
 */
import { randomUUID } from "node:crypto";
import { INDEX_BASE_LEVEL } from "@mock-kabu/shared";
import { PrismaClient } from "@prisma/client";
import { planRelistIndex } from "./relist-plan";

const prisma = new PrismaClient();

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const symbol = arg("--symbol");
/** 지정하지 않으면 재상장 직전 현재가(종가)로 연다. */
const priceArg = arg("--price");
const explicitPrice = priceArg == null ? null : Number(priceArg);
const cancelOrders = process.argv.includes("--cancel-orders");
const apply = process.argv.includes("--apply");

/**
 * 매칭 엔진이 아직 호가에 들고 있는 주문. 엔진이 이미 종결을 확정(closed_order_markers)했는데
 * 정산이 상태를 못 바꾼 행은 엔진 재기동 때도 호가에 올리지 않으므로(close-pending) 제외한다.
 */
async function liveOrders() {
  return prisma.$queryRaw<{ id: string; symbol: string }[]>`
    SELECT o.id, o.symbol FROM "order".orders o
    WHERE o.symbol = ${symbol} AND o.status IN ('OPEN', 'PARTIAL')
      AND NOT EXISTS (SELECT 1 FROM matching.closed_order_markers m WHERE m.order_id = o.id)`;
}

async function closePendingCount() {
  const [row] = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT COUNT(*) AS n FROM "order".orders o
    WHERE o.symbol = ${symbol} AND o.status IN ('OPEN', 'PARTIAL')
      AND EXISTS (SELECT 1 FROM matching.closed_order_markers m WHERE m.order_id = o.id)`;
  return Number(row?.n ?? 0);
}

async function report() {
  const [orders, waiting, holders, row] = await Promise.all([
    liveOrders(),
    prisma.conditionalOrder.count({ where: { symbol, status: "WAITING" } }),
    prisma.$queryRaw<{ nickname: string; is_bot: boolean; qty: number }[]>`
      SELECT u.nickname, u.is_bot, h.qty
      FROM account.holdings h
      JOIN account.accounts a ON a.id = h.account_id
      JOIN auth.users u ON u.id = a.user_id
      WHERE h.symbol = ${symbol} AND h.qty > 0 AND u.is_bot = false
      ORDER BY h.qty DESC`,
    prisma.marketSymbol.findUnique({ where: { symbol: symbol! } }),
  ]);
  console.log(`symbol ${symbol}: last ${row?.lastPrice}, initial ${row?.initialPrice}, listed_at ${row?.listedAt?.toISOString() ?? "-"}`);
  console.log(
    `live orders ${orders.length}, waiting conditional orders ${waiting}, close-pending (not in the engine book) ${await closePendingCount()}`,
  );
  console.log(`user holders kept 1:1: ${holders.length}${holders.map((h) => ` ${h.nickname}=${h.qty}`).join(",")}`);
  return { orders, waiting };
}

async function cancelAll() {
  const orders = await liveOrders();
  for (const order of orders) {
    const event = { topic: "order.cancel.requested", eventId: randomUUID(), orderId: order.id, symbol: order.symbol, ts: Date.now() };
    await prisma.outbox.create({ data: { eventId: event.eventId, topic: event.topic, payload: event } });
  }
  const canceled = await prisma.conditionalOrder.updateMany({
    where: { symbol, status: "WAITING" },
    data: { status: "CANCELED", failReason: "재상장으로 취소" },
  });
  console.log(`requested cancel for ${orders.length} order(s); canceled ${canceled.count} waiting conditional order(s)`);
  for (let waited = 0; waited < 120; waited += 2) {
    const remaining = (await liveOrders()).length;
    if (remaining === 0) {
      console.log("all orders are closed");
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error("orders are still live after 120s — are the API, matching engine and settlement running?");
}

async function applyRelist() {
  const { orders, waiting } = await report();
  if (orders.length > 0 || waiting > 0) throw new Error("run --cancel-orders first (and keep the bots stopped)");

  await prisma.$transaction(async (tx) => {
    const relistAt = new Date();
    const [symbols, epochs] = await Promise.all([
      tx.marketSymbol.findMany(),
      tx.indexEpoch.findMany({ orderBy: { startsAt: "asc" } }),
    ]);
    const current = symbols.find((s) => s.symbol === symbol);
    if (!current) throw new Error(`unknown symbol ${symbol}`);
    const price = explicitPrice ?? current.lastPrice;
    if (price % current.tickSize !== 0) throw new Error(`${price} is not on the ${current.tickSize} tick`);
    const plan = planRelistIndex({
      symbol: symbol!,
      listPrice: price,
      baseLevel: INDEX_BASE_LEVEL,
      epochs: epochs.map((e) => ({ startsAt: e.startsAt.getTime(), divisor: e.divisor, members: e.members })),
      initialPrices: new Map(symbols.map((s) => [s.symbol, s.initialPrice])),
      lastPrices: new Map(symbols.map((s) => [s.symbol, s.lastPrice])),
      shares: new Map(symbols.map((s) => [s.symbol, Number(s.listedShares)])),
      relistAt: relistAt.getTime(),
    });

    await tx.indexEpoch.deleteMany({});
    for (const epoch of [...plan.history, plan.next]) {
      await tx.indexEpoch.create({
        data: { startsAt: new Date(epoch.startsAt), divisor: epoch.divisor, members: epoch.members },
      });
    }
    await tx.marketSymbol.update({
      where: { symbol: symbol! },
      data: { lastPrice: price, initialPrice: price, listedAt: relistAt },
    });
    const candles = await tx.candle.deleteMany({ where: { symbol } });
    const news = await tx.newsItem.deleteMany({ where: { symbol } });
    console.log(`relisted ${symbol} at ${price} (${relistAt.toISOString()})`);
    console.log(`index level ${plan.level.toFixed(2)} kept; history members ${plan.history[0].members.join(",")}`);
    console.log(`deleted ${candles.count} candles, ${news.count} news items`);
  });
  console.log("next: restart the matching engine, then start the bots");
}

async function main() {
  if (!symbol || (explicitPrice != null && (!Number.isInteger(explicitPrice) || explicitPrice <= 0))) {
    throw new Error("usage: --symbol KABU [--price <원>] [--cancel-orders|--apply]");
  }
  if (cancelOrders) await cancelAll();
  else if (apply) await applyRelist();
  else await report();
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
