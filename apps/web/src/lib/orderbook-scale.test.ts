import { describe, expect, it } from "vitest";
import { advanceBookScale, bookBarWidth, visibleBookMax, type BookScale } from "./orderbook-scale";

describe("spot orderbook scale", () => {
  it("ignores DAON's observed 153ms overlap without changing other rows' widths", () => {
    let state: BookScale | null = advanceBookScale(null, 27, 0);
    const width = bookBarWidth(23, state.value);
    for (const [time, max] of [[549, 43], [702, 27], [1300, 42], [1450, 27]]) {
      state = advanceBookScale(state, max, time);
      expect(bookBarWidth(23, state.value)).toBe(width);
    }
    expect(state.pending).toBeNull();
  });

  it("adapts to a persistent wall, then its removal, even without further ticks", () => {
    let state = advanceBookScale(null, 27, 0);
    state = advanceBookScale(state, 80, 100);
    expect(advanceBookScale(state, 80, 899).value).toBe(27);
    state = advanceBookScale(state, 80, 900);
    expect(state.value).toBe(80);
    state = advanceBookScale(state, 27, 1000);
    expect(advanceBookScale(state, 27, 1799).value).toBe(80);
    expect(advanceBookScale(state, 27, 1800).value).toBe(27);
  });

  it("does not let ordinary jitter starve an adjustment or confirm a late spike", () => {
    let state = advanceBookScale(null, 27, 0);
    for (const [time, max] of [[100, 40], [300, 39], [600, 41], [900, 100]]) {
      state = advanceBookScale(state, max, time);
    }
    expect(state.value).toBe(39);
  });

  it("cancels a pending change when it reverses direction", () => {
    let state = advanceBookScale(null, 27, 0);
    state = advanceBookScale(state, 43, 100);
    state = advanceBookScale(state, 20, 800);
    expect(advanceBookScale(state, 20, 900).value).toBe(27);
    expect(advanceBookScale(state, 20, 1600).value).toBe(20);
  });

  it("excludes hidden ninth/tenth levels on both sides", () => {
    const asks = Array.from({ length: 10 }, (_, i) => ({ qty: i < 8 ? 23 : 1000 }));
    const bids = Array.from({ length: 10 }, (_, i) => ({ qty: i < 8 ? 27 : 2000 }));
    expect(visibleBookMax({ asks, bids })).toBe(27);
    expect(visibleBookMax({ asks: [], bids: [] })).toBe(1);
  });

  it("caps transient oversized bars and initializes different price scales immediately", () => {
    expect(bookBarWidth(43, 27)).toBe(100);
    expect(bookBarWidth(1, 1000)).toBe(2);
    expect(advanceBookScale(null, 5000, 0).value).toBe(5000);
  });
});
