/**
 * 신규 상장 종목을 시가총액 가중 지수에 편입한다 (시드로 market.symbols에 종목을 만든 뒤 실행).
 *
 *   pnpm --filter @mock-kabu/db index:add-members           # 점검만 (dry run)
 *   pnpm --filter @mock-kabu/db index:add-members -- --apply
 *
 * 지금 구간에 없는 활성 종목(shared SYMBOLS)을 찾아, 지금 시각부터 지수 수준이 이어지는 새 구간을
 * 추가한다. 신규 종목의 편입 가격은 현재가(= 막 시드된 상장가)다. 과거 구간은 건드리지 않는다.
 */
import { SYMBOLS } from "@mock-kabu/shared";
import { PrismaClient } from "@prisma/client";
import { planAddIndexMembers } from "./relist-plan";

const prisma = new PrismaClient();
const apply = process.argv.includes("--apply");

async function main() {
  await prisma.$transaction(async (tx) => {
    const [current, rows] = await Promise.all([
      tx.indexEpoch.findFirst({ orderBy: { startsAt: "desc" } }),
      tx.marketSymbol.findMany({ where: { symbol: { in: SYMBOLS.map((s) => s.symbol) } } }),
    ]);
    if (!current) throw new Error("no index epoch — run the seed first");
    const missingRows = SYMBOLS.filter((s) => !rows.some((row) => row.symbol === s.symbol)).map((s) => s.symbol);
    if (missingRows.length > 0) throw new Error(`symbols not seeded yet: ${missingRows.join(", ")}`);

    const newSymbols = rows.map((row) => row.symbol).filter((symbol) => !current.members.includes(symbol)).sort();
    if (newSymbols.length === 0) {
      console.log(`index already includes all ${rows.length} symbols`);
      return;
    }
    const { next, level } = planAddIndexMembers({
      current: { startsAt: current.startsAt.getTime(), divisor: current.divisor, members: current.members },
      newSymbols,
      lastPrices: new Map(rows.map((row) => [row.symbol, row.lastPrice])),
      shares: new Map(rows.map((row) => [row.symbol, Number(row.listedShares)])),
      at: Date.now(),
    });
    console.log(`add ${newSymbols.join(", ")} at level ${level.toFixed(2)}; divisor ${current.divisor} -> ${next.divisor}`);
    if (!apply) {
      console.log("dry run — pass --apply to write the new epoch");
      return;
    }
    await tx.indexEpoch.create({
      data: { startsAt: new Date(next.startsAt), divisor: next.divisor, members: next.members },
    });
    console.log(`index epoch added at ${new Date(next.startsAt).toISOString()} with ${next.members.length} members`);
  });
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
