/**
 * 상장 폐지 정산의 순수 계산 — DB 없이 테스트한다.
 */
import { continuingDivisor, indexLevel, type IndexEpoch } from "@mock-kabu/shared";

export interface DelistPayout {
  /** 계좌에 들어갈 현금(원) */
  payout: bigint;
  /** 실현손익 기록에 쓸 주당 가격(원) — payout = price × qty */
  price: number;
  /** 실현손익(원) = payout − costBasis */
  realized: bigint;
  /** 적용 규칙: 수익이면 현재가, 손실이면 평단가 */
  rule: "LAST_PRICE" | "AVG_COST";
}

/**
 * 사용자 보유분 현금 정산 규칙(2026-09-26 운영자 결정):
 *  - 현재가 평가액이 매입원가 이상(수익)이면 현재가로 정산
 *  - 손실이면 평단가로 정산(원금 보전). 평단가는 원 미만을 내린다 — 실현손익 기록이 price × qty − costBasis를
 *    정확히 지키게 하려는 것으로, 차이는 주당 1원 미만이다.
 */
export function delistPayout(input: { qty: number; costBasis: bigint; lastPrice: number }): DelistPayout {
  const { qty, costBasis, lastPrice } = input;
  if (!Number.isInteger(qty) || qty <= 0) throw new Error("qty must be a positive integer");
  const atMarket = BigInt(lastPrice) * BigInt(qty);
  if (atMarket >= costBasis) {
    return { payout: atMarket, price: lastPrice, realized: atMarket - costBasis, rule: "LAST_PRICE" };
  }
  const avgFloor = costBasis / BigInt(qty);
  const payout = avgFloor * BigInt(qty);
  return { payout, price: Number(avgFloor), realized: payout - costBasis, rule: "AVG_COST" };
}

/** 지수에서 종목을 뺀 새 구간 — 빼는 순간의 지수 수준이 그대로 이어지도록 제수를 다시 정한다. */
export function planRemoveIndexMembers(input: {
  current: IndexEpoch;
  removed: readonly string[];
  lastPrices: ReadonlyMap<string, number>;
  shares: ReadonlyMap<string, number>;
  at: number;
}): { next: IndexEpoch; level: number } | null {
  const { current, removed, lastPrices, shares } = input;
  const leaving = removed.filter((symbol) => current.members.includes(symbol));
  if (leaving.length === 0) return null;
  if (input.at <= current.startsAt) throw new Error("new epoch must start after the current one");
  const need = (map: ReadonlyMap<string, number>, symbol: string, what: string) => {
    const value = map.get(symbol);
    if (!value || value <= 0) throw new Error(`missing ${what} for ${symbol}`);
    return value;
  };
  const priceOf = (symbol: string) => need(lastPrices, symbol, "price");
  const sharesOf = (symbol: string) => need(shares, symbol, "listed shares");
  const level = indexLevel(current, priceOf, sharesOf);
  const members = current.members.filter((symbol) => !leaving.includes(symbol)).sort();
  if (members.length === 0) throw new Error("the index would have no members");
  const capAfter = members.reduce((sum, symbol) => sum + priceOf(symbol) * sharesOf(symbol), 0);
  return { next: { startsAt: input.at, divisor: continuingDivisor(capAfter, level), members }, level };
}
