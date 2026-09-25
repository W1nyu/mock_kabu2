/**
 * 상장 폐지 실행 (shared DELISTED_SYMBOLS의 종목).
 *
 *   pnpm --filter @mock-kabu/db delist-symbols            # 점검만 (dry run) — 무엇이 바뀌는지 출력
 *   pnpm --filter @mock-kabu/db delist-symbols -- --apply  # 한 트랜잭션으로 적용
 *
 * 반드시 매칭엔진·정산·봇을 멈춘 뒤(점검 중) 실행한다 — 미체결 주문과 홀드를 엔진 밖에서 직접 정리하기 때문이다.
 * 여러 번 실행해도 안전하다: 두 번째 실행에는 정리할 것이 남아 있지 않다.
 *
 * 하는 일:
 *  1. 폐지 종목의 미체결 주문(OPEN/PARTIAL) 취소 — 매수 현금 홀드·매도 수량 홀드 해제
 *  2. 대기 중 예약 주문·체결 후 자동 보호 의도 취소
 *  3. 보유분 정리 — 사용자(봇 아님): 수익이면 현재가, 손실이면 평단가로 현금 지급(원장 DELISTING + 실현손익 기록).
 *     봇: 유동성 재고라 현금 없이 삭제
 *  4. 아직 발행 안 된 폐지 종목 outbox 이벤트는 발행한 것으로 표시(엔진이 받아도 건너뛰지만 쌓이지 않게)
 *  5. 지수 구간에서 제외 — 지수 수준이 이어지도록 새 구간 추가
 */
import { DELISTED_SYMBOLS } from "@mock-kabu/shared";
import { Prisma, PrismaClient } from "@prisma/client";
import { delistPayout, planRemoveIndexMembers } from "./delist-plan";

const prisma = new PrismaClient();
const apply = process.argv.includes("--apply");
const SYMBOLS = DELISTED_SYMBOLS.map((symbol) => symbol.symbol);
const LIVE = ["OPEN", "PARTIAL"];

const won = (value: bigint | number) => `${Number(value).toLocaleString("ko-KR")}원`;

async function main() {
  if (SYMBOLS.length === 0) {
    console.log("no delisted symbols");
    return;
  }
  console.log(`delisting ${SYMBOLS.join(", ")} (${apply ? "APPLY" : "dry run"})`);

  await prisma.$transaction(
    async (tx) => {
      const now = new Date();
      const market = await tx.marketSymbol.findMany({ where: { symbol: { in: SYMBOLS } } });
      const lastPrice = new Map(market.map((row) => [row.symbol, row.lastPrice]));
      for (const symbol of SYMBOLS) if (!lastPrice.get(symbol)) throw new Error(`no market row/price for ${symbol}`);

      // 1. 미체결 주문 취소 + 홀드 해제
      const orders = await tx.order.findMany({ where: { symbol: { in: SYMBOLS }, status: { in: LIVE } } });
      const cashRelease = new Map<string, bigint>();
      const qtyRelease = new Map<string, number>(); // `${accountId}:${symbol}`
      for (const order of orders) {
        const remaining = order.qty - order.filledQty;
        if (remaining <= 0) continue;
        if (order.side === "BUY") {
          cashRelease.set(order.accountId, (cashRelease.get(order.accountId) ?? 0n) + order.holdPerUnit * BigInt(remaining));
        } else {
          const key = `${order.accountId}:${order.symbol}`;
          qtyRelease.set(key, (qtyRelease.get(key) ?? 0) + remaining);
        }
      }
      console.log(`1) open orders: ${orders.length} (cash release ${cashRelease.size} accounts, share release ${qtyRelease.size} holdings)`);

      // 2. 예약 주문·브래킷
      const waiting = await tx.conditionalOrder.count({ where: { symbol: { in: SYMBOLS }, status: "WAITING" } });
      const brackets = await tx.bracketIntent.count({ where: { symbol: { in: SYMBOLS }, status: "PENDING" } });
      console.log(`2) waiting conditional orders: ${waiting}, pending bracket intents: ${brackets}`);

      // 3. 보유분
      const holdings = await tx.$queryRaw<
        { id: string; account_id: string; symbol: string; qty: number; cost_basis: bigint; is_bot: boolean; nickname: string }[]
      >`
        SELECT h.id, h.account_id, h.symbol, h.qty, h.cost_basis, u.is_bot, u.nickname
        FROM account.holdings h
        JOIN account.accounts a ON a.id = h.account_id
        JOIN auth.users u ON u.id = a.user_id
        WHERE h.symbol IN (${Prisma.join(SYMBOLS)}) AND h.qty > 0
      `;
      const users = holdings.filter((h) => !h.is_bot);
      const bots = holdings.filter((h) => h.is_bot);
      const payouts = users.map((h) => ({
        holding: h,
        ...delistPayout({ qty: h.qty, costBasis: h.cost_basis, lastPrice: lastPrice.get(h.symbol)! }),
      }));
      console.log(`3) holdings: ${users.length} user, ${bots.length} bot`);
      for (const p of payouts) {
        const avg = Number(p.holding.cost_basis) / p.holding.qty;
        console.log(
          `   ${p.holding.nickname} ${p.holding.symbol} ${p.holding.qty}주 평단 ${won(Math.round(avg))} 현재가 ${won(lastPrice.get(p.holding.symbol)!)}` +
            ` → ${p.rule === "LAST_PRICE" ? "현재가" : "평단가"} 정산 ${won(p.payout)} (실현 ${won(p.realized)})`,
        );
      }

      // 5. 지수
      const epoch = await tx.indexEpoch.findFirst({ orderBy: { startsAt: "desc" } });
      const stocks = await tx.marketSymbol.findMany({ where: { kind: "STOCK" } });
      const plan = epoch
        ? planRemoveIndexMembers({
            current: { startsAt: epoch.startsAt.getTime(), divisor: epoch.divisor, members: epoch.members },
            removed: SYMBOLS,
            lastPrices: new Map(stocks.map((row) => [row.symbol, row.lastPrice])),
            shares: new Map(stocks.map((row) => [row.symbol, Number(row.listedShares)])),
            at: now.getTime(),
          })
        : null;
      console.log(
        plan
          ? `5) index: remove ${SYMBOLS.filter((s) => epoch!.members.includes(s)).join(", ")} at level ${plan.level.toFixed(2)}; ${epoch!.members.length} → ${plan.next.members.length} members`
          : "5) index: already excludes the delisted symbols",
      );

      if (!apply) {
        console.log("dry run — pass --apply to write");
        return;
      }

      for (const order of orders) {
        await tx.order.update({ where: { id: order.id }, data: { status: "CANCELED" } });
      }
      for (const [accountId, amount] of cashRelease) {
        await tx.$executeRaw`
          UPDATE account.accounts SET hold_amount = hold_amount - ${amount}, version = version + 1 WHERE id = ${accountId}
        `;
      }
      for (const [key, qty] of qtyRelease) {
        const [accountId, symbol] = key.split(":");
        await tx.$executeRaw`
          UPDATE account.holdings SET hold_qty = GREATEST(hold_qty - ${qty}, 0), version = version + 1
          WHERE account_id = ${accountId} AND symbol = ${symbol}
        `;
      }
      await tx.conditionalOrder.updateMany({
        where: { symbol: { in: SYMBOLS }, status: "WAITING" },
        data: { status: "CANCELED", failReason: "상장 폐지" },
      });
      await tx.bracketIntent.updateMany({
        where: { symbol: { in: SYMBOLS }, status: "PENDING" },
        data: { status: "CANCELED", note: "상장 폐지" },
      });

      for (const p of payouts) {
        const h = p.holding;
        const [row] = await tx.$queryRaw<{ balance: bigint }[]>`
          UPDATE account.accounts SET balance = balance + ${p.payout}, version = version + 1
          WHERE id = ${h.account_id} RETURNING balance
        `;
        await tx.ledgerEntry.create({
          data: { accountId: h.account_id, delta: p.payout, balanceAfter: row.balance, reason: "DELISTING", refId: h.symbol },
        });
        await tx.realizedPnl.create({
          data: {
            accountId: h.account_id,
            symbol: h.symbol,
            // 체결이 없는 정산 — 정합성 검사는 delist: 접두사를 체결 대조에서 뺀다.
            tradeId: `delist:${h.symbol}:${h.account_id}`,
            qty: h.qty,
            price: p.price,
            costBasis: h.cost_basis,
            realized: p.realized,
            tradedAt: now,
          },
        });
      }
      await tx.holding.deleteMany({ where: { symbol: { in: SYMBOLS } } });

      const staleOutbox = await tx.$executeRaw`
        UPDATE "order".outbox SET published_at = now()
        WHERE published_at IS NULL AND payload->>'symbol' IN (${Prisma.join(SYMBOLS)})
      `;
      console.log(`4) stale outbox events marked published: ${staleOutbox}`);

      if (plan) {
        await tx.indexEpoch.create({
          data: { startsAt: new Date(plan.next.startsAt), divisor: plan.next.divisor, members: plan.next.members },
        });
      }
      console.log(`applied: ${orders.length} orders canceled, ${payouts.length} user payouts, ${bots.length} bot holdings removed`);
    },
    { timeout: 120_000 },
  );
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
