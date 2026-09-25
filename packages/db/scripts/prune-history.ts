/**
 * 오래된 봇 이력 정리 (운영 보존 정책).
 *
 * 봇 20계정이 하루 수십만 건을 거래하므로 orders/trades/ledger가 사용자 이력의 수천 배로 자란다.
 * 이 스크립트는 **봇만 관련된** 오래된 행을 지우고, 사용자 계정이 한쪽이라도 낀 체결·주문·원장은
 * 그대로 둔다. 캔들·실현손익 같은 파생 데이터는 이미 계산돼 있어 영향이 없다.
 *
 *   pnpm prune:history                       # dry-run: 지울 행 수만 출력
 *   pnpm prune:history -- --apply            # 실제 삭제 (배치 5,000행)
 *   pnpm prune:history -- --apply --orders-days 7 --trades-days 30 --news-days 30 --candles-days 30 --compact-bot-ledger
 *
 * 정리 대상 (기본 보존 기간):
 *  - order.orders            봇 계정의 종결(FILLED/CANCELED/REJECTED) 주문, 7일
 *  - order.conditional_orders 봇 계정의 비대기(TRIGGERED/CANCELED/FAILED) 행, 7일
 *  - matching.trades          양쪽 모두 봇인 체결, 30일  (+ 그 실현손익 행, + 정산 claim account.processed_events)
 *  - account.processed_events 30일 지난 비체결(order.closed) 정산 claim. 체결 claim은 체결 행이 남는 한 유지.
 *  - market.news_items        30일
 *  - market.candles·reference_candles  1분 봉, 30일. 지우기 전에 같은 구간을 1시간 봉('1h')으로 합쳐 남긴다 —
 *                             1h·4h·1d 차트와 지수 "전체" 차트는 두 행을 함께 읽으므로 오래된 구간도 보인다.
 *  - account.ledger_entries   (--compact-bot-ledger) 봇 계정의 7일 지난 원장을 계정당 1행(COMPACTED)으로 압축.
 *                             sum(delta) == balance 불변식은 그대로 유지된다.
 *
 * outbox·멱등 claim은 각 프로세스가 스스로 지우고(shared/log-retention), 자산 스냅샷은 API가 압축한다.
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const BATCH = 5_000;
const CLOSED_EVENT_CLAIM_DAYS = 30;

interface Options {
  apply: boolean;
  ordersDays: number;
  tradesDays: number;
  newsDays: number;
  candlesDays: number;
  compactBotLedger: boolean;
  ledgerDays: number;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    apply: false,
    ordersDays: 7,
    tradesDays: 30,
    newsDays: 30,
    candlesDays: 30,
    compactBotLedger: false,
    ledgerDays: 7,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => Number(argv[++index]);
    if (arg === "--apply") options.apply = true;
    else if (arg === "--orders-days") options.ordersDays = next();
    else if (arg === "--trades-days") options.tradesDays = next();
    else if (arg === "--news-days") options.newsDays = next();
    else if (arg === "--candles-days") options.candlesDays = next();
    else if (arg === "--ledger-days") options.ledgerDays = next();
    else if (arg === "--compact-bot-ledger") options.compactBotLedger = true;
  }
  for (const [name, value] of Object.entries(options)) {
    if (typeof value === "number" && (!Number.isFinite(value) || value < 1)) {
      throw new Error(`${name} must be a positive number of days`);
    }
  }
  return options;
}

const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);

async function count(sql: string, ...params: unknown[]): Promise<number> {
  const [row] = await prisma.$queryRawUnsafe<{ n: bigint }[]>(sql, ...params);
  return Number(row?.n ?? 0n);
}

/** 배치 삭제. 지운 총 행 수를 돌려준다. */
async function deleteBatched(sql: string, ...params: unknown[]): Promise<number> {
  let total = 0;
  for (;;) {
    const removed = await prisma.$executeRawUnsafe(sql, ...params);
    total += removed;
    if (removed < BATCH) return total;
  }
}

const BOT_ACCOUNTS = `SELECT a.id FROM account.accounts a JOIN auth.users u ON u.id = a.user_id WHERE u.is_bot`;

/**
 * 1분 봉을 1시간 봉으로 합친 뒤 지운다. 기준 시각을 정시로 내려 한 시간이 반만 합쳐지는 일이 없게 하고,
 * 하루치씩 한 트랜잭션에서 합친 뒤 지운다 — 중간에 멈춰도 합쳐진 구간과 남은 1분 봉이 겹치지 않는다.
 * 이미 있는 1시간 봉(앞선 실행이 같은 시를 합친 경우)은 앞 구간으로 보고 이어 붙인다.
 */
async function rollupMinuteCandles(
  target: { table: string; key: string; volume: boolean },
  before: Date,
  options: Options,
): Promise<void> {
  const { table, key, volume } = target;
  console.log(`1m candles in ${table} (>${options.candlesDays}d): ${await count(
    `SELECT COUNT(*) AS n FROM ${table} WHERE interval = '1m' AND ts < $1`,
    before,
  )}`);
  if (!options.apply) return;
  const [oldest] = await prisma.$queryRawUnsafe<{ ts: Date | null }[]>(
    `SELECT MIN(ts) AS ts FROM ${table} WHERE interval = '1m' AND ts < $1`,
    before,
  );
  const volumeColumns = volume ? ", volume" : "";
  const volumeSelect = volume ? ", SUM(volume)::bigint" : "";
  const volumeMerge = volume ? `, volume = ${table}.volume + EXCLUDED.volume` : "";
  let rolled = 0;
  let removed = 0;
  for (let from = oldest?.ts ? new Date(Math.floor(oldest.ts.getTime() / 86_400_000) * 86_400_000) : before; from < before; ) {
    const to = new Date(Math.min(from.getTime() + 86_400_000, before.getTime()));
    const [inserted, deleted] = await prisma.$transaction([
      prisma.$executeRawUnsafe(
        `INSERT INTO ${table} (${key}, interval, ts, open, high, low, close${volumeColumns})
         SELECT ${key}, '1h', date_trunc('hour', ts),
           (array_agg(open ORDER BY ts ASC))[1], MAX(high), MIN(low),
           (array_agg(close ORDER BY ts DESC))[1]${volumeSelect}
         FROM ${table}
         WHERE interval = '1m' AND ts >= $1 AND ts < $2
         GROUP BY ${key}, date_trunc('hour', ts)
         ON CONFLICT (${key}, interval, ts) DO UPDATE SET
           high = GREATEST(${table}.high, EXCLUDED.high),
           low = LEAST(${table}.low, EXCLUDED.low),
           close = EXCLUDED.close${volumeMerge}`,
        from,
        to,
      ),
      prisma.$executeRawUnsafe(`DELETE FROM ${table} WHERE interval = '1m' AND ts >= $1 AND ts < $2`, from, to),
    ]);
    rolled += inserted;
    removed += deleted;
    from = to;
  }
  console.log(`  rolled ${removed} 1m candles into ${rolled} 1h candles`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  console.log(options.apply ? "APPLY 모드: 실제로 삭제합니다" : "DRY-RUN: 지울 행 수만 계산합니다 (--apply로 실행)");

  // 1) 봇의 종결 주문
  const ordersBefore = daysAgo(options.ordersDays);
  const ordersWhere = `WHERE account_id IN (${BOT_ACCOUNTS}) AND status IN ('FILLED','CANCELED','REJECTED') AND created_at < $1`;
  console.log(`bot terminal orders (>${options.ordersDays}d): ${await count(`SELECT COUNT(*) AS n FROM "order".orders ${ordersWhere}`, ordersBefore)}`);
  if (options.apply) {
    const removed = await deleteBatched(
      `DELETE FROM "order".orders WHERE id IN (SELECT id FROM "order".orders ${ordersWhere} LIMIT ${BATCH})`,
      ordersBefore,
    );
    console.log(`  deleted ${removed}`);
  }

  // 2) 봇의 종결 조건부 주문
  const conditionalWhere = `WHERE account_id IN (${BOT_ACCOUNTS}) AND status <> 'WAITING' AND created_at < $1`;
  console.log(`bot settled conditional orders (>${options.ordersDays}d): ${await count(`SELECT COUNT(*) AS n FROM "order".conditional_orders ${conditionalWhere}`, ordersBefore)}`);
  if (options.apply) {
    const removed = await deleteBatched(
      `DELETE FROM "order".conditional_orders WHERE id IN (SELECT id FROM "order".conditional_orders ${conditionalWhere} LIMIT ${BATCH})`,
      ordersBefore,
    );
    console.log(`  deleted ${removed}`);
  }

  // 3) 봇 ↔ 봇 체결 (+ 그 체결의 봇 실현손익 행). 사용자가 한쪽이라도 끼면 남긴다.
  const tradesBefore = daysAgo(options.tradesDays);
  const tradesWhere = `WHERE buyer_account_id IN (${BOT_ACCOUNTS}) AND seller_account_id IN (${BOT_ACCOUNTS}) AND created_at < $1`;
  console.log(`bot-only trades (>${options.tradesDays}d): ${await count(`SELECT COUNT(*) AS n FROM matching.trades ${tradesWhere}`, tradesBefore)}`);
  console.log(
    `  their realized_pnl rows: ${await count(
      `SELECT COUNT(*) AS n FROM account.realized_pnl r WHERE r.trade_id IN (SELECT id FROM matching.trades ${tradesWhere})`,
      tradesBefore,
    )}`,
  );
  if (options.apply) {
    // 실현손익 행을 먼저 지워야 정합성 검사(realized ↔ trade 1:1)가 중간에도 깨지지 않는다.
    const removedPnl = await deleteBatched(
      `DELETE FROM account.realized_pnl WHERE id IN (
         SELECT r.id FROM account.realized_pnl r
         WHERE r.trade_id IN (SELECT id FROM matching.trades ${tradesWhere}) LIMIT ${BATCH})`,
      tradesBefore,
    );
    // 체결의 event id == trade id. 체결을 지우면 그 정산 claim도 더 이상 증거로 쓰이지 않는다.
    const removedClaims = await deleteBatched(
      `DELETE FROM account.processed_events WHERE event_id IN (
         SELECT p.event_id FROM account.processed_events p
         WHERE p.event_id IN (SELECT id FROM matching.trades ${tradesWhere}) LIMIT ${BATCH})`,
      tradesBefore,
    );
    const removedTrades = await deleteBatched(
      `DELETE FROM matching.trades WHERE id IN (SELECT id FROM matching.trades ${tradesWhere} LIMIT ${BATCH})`,
      tradesBefore,
    );
    console.log(`  deleted ${removedTrades} trades, ${removedPnl} realized rows, ${removedClaims} settlement claims`);
  }

  // 4) order.closed 정산 claim. 정산 스트림은 ACK된 이벤트만 trim하고,
  // 이미 발행된 outbox는 별도로 정리한다. 30일 이후 비체결 claim만 지우며,
  // 체결 claim은 matching.trades의 증거이므로 그 체결이 남아 있는 동안 보존한다.
  const closedClaimsBefore = daysAgo(CLOSED_EVENT_CLAIM_DAYS);
  const closedClaimsWhere = `WHERE p.processed_at < $1 AND NOT EXISTS (
    SELECT 1 FROM matching.trades t WHERE t.id = p.event_id
  )`;
  console.log(`non-trade settlement claims (>${CLOSED_EVENT_CLAIM_DAYS}d): ${await count(
    `SELECT COUNT(*) AS n FROM account.processed_events p ${closedClaimsWhere}`,
    closedClaimsBefore,
  )}`);
  if (options.apply) {
    const removed = await deleteBatched(
      `DELETE FROM account.processed_events WHERE event_id IN (
         SELECT p.event_id FROM account.processed_events p ${closedClaimsWhere} LIMIT ${BATCH})`,
      closedClaimsBefore,
    );
    console.log(`  deleted ${removed}`);
  }

  // 5) 오래된 뉴스
  const newsBefore = daysAgo(options.newsDays);
  console.log(`news items (>${options.newsDays}d): ${await count(`SELECT COUNT(*) AS n FROM market.news_items WHERE created_at < $1`, newsBefore)}`);
  if (options.apply) {
    const removed = await deleteBatched(
      `DELETE FROM market.news_items WHERE id IN (SELECT id FROM market.news_items WHERE created_at < $1 LIMIT ${BATCH})`,
      newsBefore,
    );
    console.log(`  deleted ${removed}`);
  }

  // 6) 1분 봉 → 1시간 봉 압축 (현물 봉, 선물 기초자산 봉).
  const candlesBefore = new Date(Math.floor(daysAgo(options.candlesDays).getTime() / 3_600_000) * 3_600_000);
  await rollupMinuteCandles({ table: "market.candles", key: "symbol", volume: true }, candlesBefore, options);
  await rollupMinuteCandles({ table: "market.reference_candles", key: "code", volume: false }, candlesBefore, options);

  // 7) 봇 원장 압축 (opt-in). 계정별로 오래된 행을 한 줄로 합친다 — 합계·마지막 잔액 보존.
  if (options.compactBotLedger) {
    const ledgerBefore = daysAgo(options.ledgerDays);
    const candidates = await prisma.$queryRawUnsafe<{ account_id: string; n: bigint }[]>(
      `SELECT account_id, COUNT(*) AS n FROM account.ledger_entries
       WHERE account_id IN (${BOT_ACCOUNTS}) AND created_at < $1 AND reason <> 'COMPACTED'
       GROUP BY account_id HAVING COUNT(*) > 1`,
      ledgerBefore,
    );
    const total = candidates.reduce((sum, row) => sum + Number(row.n), 0);
    console.log(`bot ledger entries to compact (>${options.ledgerDays}d): ${total} rows across ${candidates.length} accounts`);
    if (options.apply) {
      for (const { account_id } of candidates) {
        await prisma.$transaction(async (tx) => {
          const [agg] = await tx.$queryRawUnsafe<{ total: bigint; last_id: bigint; last_balance: bigint; first_at: Date }[]>(
            `SELECT SUM(delta) AS total, MAX(id) AS last_id,
                    (array_agg(balance_after ORDER BY id DESC))[1] AS last_balance,
                    MIN(created_at) AS first_at
             FROM account.ledger_entries WHERE account_id = $1 AND created_at < $2`,
            account_id,
            ledgerBefore,
          );
          if (!agg || agg.last_id == null) return;
          await tx.$executeRawUnsafe(`DELETE FROM account.ledger_entries WHERE account_id = $1 AND created_at < $2`, account_id, ledgerBefore);
          // 압축 행은 원래 구간의 첫 시각을 달고 들어가 이후 행보다 항상 앞선다.
          await tx.$executeRawUnsafe(
            `INSERT INTO account.ledger_entries (account_id, delta, balance_after, reason, ref_id, created_at)
             VALUES ($1, $2, $3, 'COMPACTED', $4, $5)`,
            account_id,
            agg.total,
            agg.last_balance,
            `through-${agg.last_id}`,
            agg.first_at,
          );
        });
      }
      console.log(`  compacted ${candidates.length} accounts`);
    }
  }

  if (options.apply) {
    console.log("\n완료. 공간 회수는 autovacuum이 처리합니다 (즉시 필요하면 VACUUM ANALYZE). pnpm check:consistency로 확인하세요.");
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
