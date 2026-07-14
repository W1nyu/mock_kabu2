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
  {
    id: "amzn-us",
    symbol: "AMZN",
    name: "Amazon.com, Inc.",
    exchange: "NASDAQ",
    currency: "USD",
    priceScale: 100,
  },
  {
    id: "googl-us",
    symbol: "GOOGL",
    name: "Alphabet Inc. Class A",
    exchange: "NASDAQ",
    currency: "USD",
    priceScale: 100,
  },
  {
    id: "meta-us",
    symbol: "META",
    name: "Meta Platforms, Inc.",
    exchange: "NASDAQ",
    currency: "USD",
    priceScale: 100,
  },
  {
    id: "tsla-us",
    symbol: "TSLA",
    name: "Tesla, Inc.",
    exchange: "NASDAQ",
    currency: "USD",
    priceScale: 100,
  },
  {
    id: "amd-us",
    symbol: "AMD",
    name: "Advanced Micro Devices, Inc.",
    exchange: "NASDAQ",
    currency: "USD",
    priceScale: 100,
  },
  {
    id: "nflx-us",
    symbol: "NFLX",
    name: "Netflix, Inc.",
    exchange: "NASDAQ",
    currency: "USD",
    priceScale: 100,
  },
  {
    id: "jpm-us",
    symbol: "JPM",
    name: "JPMorgan Chase & Co.",
    exchange: "NYSE",
    currency: "USD",
    priceScale: 100,
  },
];

export function findReplayDataset(id: string): ReplayDataset | undefined {
  return REPLAY_DATASETS.find((dataset) => dataset.id === id);
}
