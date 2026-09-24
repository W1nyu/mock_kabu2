import { describe, expect, it } from "vitest";
import { indexSessionBase } from "../index-session";

describe("indexSessionBase", () => {
  it("uses the actual 09:00 level without resetting the index to 1,000", () => {
    const open = Date.parse("2026-09-24T00:00:00Z");
    const points = [
      { ts: open - 60_000, value: 920.11 },
      { ts: open, value: 921.77 },
      { ts: open + 60_000, value: 925.31 },
    ];
    expect(indexSessionBase(points, open + 60_000)).toBe(921.77);
  });

  it("carries the previous level when the opening minute has no trade", () => {
    const open = Date.parse("2026-09-24T00:00:00Z");
    expect(indexSessionBase([{ ts: open - 60_000, value: 921.77 }], open + 60_000)).toBe(921.77);
  });
});
