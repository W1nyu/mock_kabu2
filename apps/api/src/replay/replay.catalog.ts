import type { ReplayDataset } from "./replay.types";

/**
 * These instruments live only in the replay lab. They never enter
 * market.symbols, the Redis order book, matching.trades, or settlement.
 */
export const REPLAY_DATASETS: readonly ReplayDataset[] = [
  {
    id: "aapl-us",
    symbol: "AAPL",
    name: "Apple Inc.",
    exchange: "NASDAQ",
    currency: "USD",
    priceScale: 100,
    fallbackFixture: "aapl-2015-08",
  },
  {
    id: "msft-us",
    symbol: "MSFT",
    name: "Microsoft Corporation",
    exchange: "NASDAQ",
    currency: "USD",
    priceScale: 100,
  },
  {
    id: "nvda-us",
    symbol: "NVDA",
    name: "NVIDIA Corporation",
    exchange: "NASDAQ",
    currency: "USD",
    priceScale: 100,
  },
];

export function findReplayDataset(id: string): ReplayDataset | undefined {
  return REPLAY_DATASETS.find((dataset) => dataset.id === id);
}
