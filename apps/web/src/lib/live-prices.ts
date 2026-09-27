import type { Dispatch, SetStateAction } from "react";
import { subscribe } from "./socket";
import { createTickBatcher } from "./tick-batch";

export type LivePrices = Record<string, number>;

/** 모아 둔 체결 가격을 맵에 반영한다. 바뀐 게 없으면 같은 객체를 돌려줘 다시 그리지 않는다. */
export function mergePrices(prev: LivePrices, items: { symbol: string; price: number }[]): LivePrices {
  let next = prev;
  for (const { symbol, price } of items) {
    if (next[symbol] === price) continue;
    if (next === prev) next = { ...prev };
    next[symbol] = price;
  }
  return next;
}

/**
 * 여러 종목의 체결가를 구독해 `{ 종목: 최근가 }`로 반영한다. 전 종목 체결은 초당 수십 건이라
 * 건마다 setState하지 않고 intervalMs씩 모아서 한 번에 반영한다. 반환값은 구독 해제.
 */
export function subscribeLivePrices(
  symbols: string[],
  setLive: Dispatch<SetStateAction<LivePrices>>,
  intervalMs = 200,
): () => void {
  const batcher = createTickBatcher<{ symbol: string; price: number }>(
    (items) => setLive((prev) => mergePrices(prev, items)),
    intervalMs,
  );
  const unsubscribe = subscribe(
    symbols.map((symbol) => `trades:${symbol}`),
    ({ channel, data }) => {
      const price = Number(data?.price);
      if (!Number.isFinite(price)) return;
      batcher.push({ symbol: channel.slice("trades:".length), price });
    },
  );
  return () => {
    unsubscribe();
    batcher.cancel();
  };
}
