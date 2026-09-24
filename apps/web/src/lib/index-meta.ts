import { indexLevel } from "@mock-kabu/shared";

/** `/market/index/meta` — 현재 지수 구간(편입 종목·발행주식수·제수). */
export interface IndexMeta {
  startsAt: number;
  divisor: number;
  members: { symbol: string; listedShares: number }[];
}

/** 실시간 가격으로 현재 지수를 계산한다 — 서버 `/market/index`와 같은 시가총액 가중 식. */
export function liveIndexLevel(meta: IndexMeta, priceOf: (symbol: string) => number | undefined): number | null {
  const shares = new Map(meta.members.map((m) => [m.symbol, m.listedShares]));
  let missing = false;
  const level = indexLevel(
    { divisor: meta.divisor, members: meta.members.map((m) => m.symbol) },
    (symbol) => {
      const price = priceOf(symbol);
      if (price == null) missing = true;
      return price ?? 0;
    },
    (symbol) => shares.get(symbol) ?? 0,
  );
  return missing || !(meta.divisor > 0) ? null : level;
}
