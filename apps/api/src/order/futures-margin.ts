import { UnprocessableEntityException } from "@nestjs/common";
import { futureMarginPerContract, futuresTradingDay, nextFuturesSettlementAt, optionWriterMarginPerContract, type FutureDef, type OptionDef, type OrderSide } from "@mock-kabu/shared";

/**
 * 선물 때문에 쓸 수 없는 현금(원) = 포지션 위탁증거금 합계 + 미수금.
 *
 * 포지션 증거금은 계좌의 holdAmount가 아니라 account.futures_positions.margin_held에 둔다 — 손실이 나면
 * 잔액이 증거금보다 작아질 수 있는데(추가증거금 상황) 그것이 현물의 "묶음 ≤ 잔액" 불변식(DB 제약)을
 * 깨지 않게 하려는 분리다. 미수금은 손실이 잔액을 넘은 부분(account.futures_debts).
 *
 * 주문 가능 금액 = 잔액 − holdAmount − 이 값. 현물 주문·선물 주문·이체·계좌 조회가 모두 같은 식을 쓴다.
 */
interface FuturesReader {
  futuresPosition: {
    aggregate(args: {
      where: { accountId: string };
      _sum: { marginHeld: true };
    }): Promise<{ _sum: { marginHeld: bigint | null } }>;
  };
  futuresDebt: {
    findUnique(args: { where: { accountId: string } }): Promise<{ amount: bigint } | null>;
  };
}

export interface FuturesEncumbrance {
  margin: bigint;
  debt: bigint;
  total: bigint;
}

/** PrismaClient, 또는 계좌 락 안의 트랜잭션(concurrency TxLike — 모델 델리게이트가 인덱스 시그니처라 느슨하게 받는다) */
export async function futuresEncumbrance(
  db: FuturesReader | { [key: string]: any },
  accountId: string,
): Promise<FuturesEncumbrance> {
  const reader = db as FuturesReader;
  const [margin, debt] = await Promise.all([
    reader.futuresPosition.aggregate({ where: { accountId }, _sum: { marginHeld: true } }),
    reader.futuresDebt.findUnique({ where: { accountId } }),
  ]);
  const marginHeld = margin._sum.marginHeld ?? 0n;
  const owed = debt?.amount ?? 0n;
  return { margin: marginHeld, debt: owed, total: marginHeld + owed };
}

/** 주문 가능 금액 계산용 합계 */
export async function futuresMarginHeld(db: FuturesReader | { [key: string]: any }, accountId: string): Promise<bigint> {
  return (await futuresEncumbrance(db, accountId)).total;
}

/**
 * 선물 주문 한 건의 계약당 홀드(원).
 *  - 청산 주문: 보유 포지션의 반대 방향이고, 수량이 "아직 청산 주문이 걸리지 않은 포지션" 이내면 0.
 *    이미 걸린 증거금 0 청산 주문(같은 방향, 미체결 잔량)만큼은 빼고 센다 — 같은 포지션으로 청산 주문을 여러 번 내
 *    반대 포지션을 증거금 없이 여는 것을 막는다.
 *  - 그 밖(신규·뒤집기): 계좌·종목의 레버리지로 계산한 계약당 위탁증거금.
 * 계좌 락 안의 트랜잭션으로 부른다.
 */
export async function futuresOrderHoldPerUnit(
  db: { [key: string]: any },
  accountId: string,
  def: FutureDef,
  side: OrderSide,
  qty: number,
  priceUnits: number,
): Promise<bigint> {
  const position = (await db.futuresPosition.findUnique({
    where: { accountId_symbol: { accountId, symbol: def.symbol } },
  })) as { qty: number; leverage: number | null } | null;
  const held = position?.qty ?? 0;
  const closing = (side === "SELL" && held > 0) || (side === "BUY" && held < 0);
  if (closing) {
    const pending = (await db.order.findMany({
      where: { accountId, symbol: def.symbol, side, status: { in: ["OPEN", "PARTIAL"] }, holdPerUnit: 0n },
      select: { qty: true, filledQty: true },
    })) as { qty: number; filledQty: number }[];
    const reserved = pending.reduce((sum, order) => sum + (order.qty - order.filledQty), 0);
    if (qty <= Math.abs(held) - reserved) return 0n;
  }
  return futureMarginPerContract(def, priceUnits, position?.leverage ?? null);
}

/**
 * 옵션 주문 한 건의 계약당 홀드(원).
 *  - 매수: 프리미엄 = 가격 × 승수 (쓰기 포지션을 되사는 주문도 프리미엄은 내야 한다)
 *  - 매도: 보유(매수) 수량 이내이고 이미 걸린 청산 매도를 뺀 만큼이면 0(청산).
 *          그 밖(쓰기)은 봇만 — 계약당 쓰기 증거금(행사가 명목 × 비율). 사용자는 거부한다.
 * 계좌 락 안의 트랜잭션으로 부른다.
 */
export async function optionOrderHoldPerUnit(
  db: { [key: string]: any },
  accountId: string,
  def: OptionDef,
  side: OrderSide,
  qty: number,
  priceUnits: number,
): Promise<bigint> {
  if (def.family.retired) {
    // 마지막 만기가 지난 거래 종료 옵션은 누구의 주문도 받지 않는다(남은 포지션이 없다).
    const series = (await db.optionSeries.findUnique({ where: { symbol: def.symbol } })) as { tradingDay: string } | null;
    if (!series || series.tradingDay < futuresTradingDay(nextFuturesSettlementAt(Date.now()))) {
      throw new UnprocessableEntityException("만기가 지난 옵션입니다");
    }
  }
  if (def.family.retired && side === "BUY" && !(await isBotAccount(db, accountId))) {
    // 거래를 끝낸 옵션은 새로 사지 못한다. 봇(마켓메이커)의 매수 호가는 보유자가 팔 수 있게 남긴다.
    throw new UnprocessableEntityException("거래가 끝난 옵션입니다. 보유분 매도만 할 수 있습니다");
  }
  if (side === "BUY") return BigInt(priceUnits) * BigInt(def.unitValue);
  const position = (await db.futuresPosition.findUnique({
    where: { accountId_symbol: { accountId, symbol: def.symbol } },
  })) as { qty: number } | null;
  const held = Math.max(0, position?.qty ?? 0);
  if (held > 0) {
    const pending = (await db.order.findMany({
      where: { accountId, symbol: def.symbol, side: "SELL", status: { in: ["OPEN", "PARTIAL"] }, holdPerUnit: 0n },
      select: { qty: true, filledQty: true },
    })) as { qty: number; filledQty: number }[];
    const reserved = pending.reduce((sum, order) => sum + (order.qty - order.filledQty), 0);
    if (qty <= held - reserved) return 0n;
  }
  if (!(await isBotAccount(db, accountId))) throw new UnprocessableEntityException("옵션은 보유한 수량만 매도(청산)할 수 있습니다");
  if (def.family.retired) throw new UnprocessableEntityException("거래가 끝난 옵션은 새로 쓸 수 없습니다");
  const series = (await db.optionSeries.findUnique({ where: { symbol: def.symbol } })) as { strike: number } | null;
  if (!series) throw new UnprocessableEntityException("오늘의 행사가가 아직 정해지지 않았습니다");
  return optionWriterMarginPerContract(def, series.strike);
}

async function isBotAccount(db: { [key: string]: any }, accountId: string): Promise<boolean> {
  const account = (await db.account.findUnique({ where: { id: accountId }, select: { userId: true } })) as { userId: string } | null;
  if (!account) return false;
  const user = (await db.user.findUnique({ where: { id: account.userId }, select: { isBot: true } })) as { isBot: boolean } | null;
  return user?.isBot === true;
}
