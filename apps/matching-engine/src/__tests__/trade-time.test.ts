import { describe, expect, it } from "vitest";
import { nextTradeMs } from "../engine";

describe("trade timestamps", () => {
  it("stay strictly increasing even when several fills land in the same millisecond", () => {
    let last = 0;
    const stamps = [1_000, 1_000, 1_000, 999, 1_005].map((now) => (last = nextTradeMs(last, now)));
    expect(stamps).toEqual([1_000, 1_001, 1_002, 1_003, 1_005]);
  });
});
