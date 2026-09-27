import { afterEach, describe, expect, it } from "vitest";
import { clearSnapshots, readSnapshot, writeSnapshot } from "../snapshot";

describe("snapshot", () => {
  afterEach(() => clearSnapshots());

  it("returns the last written value while it is fresh", () => {
    writeSnapshot("overview", [{ symbol: "KABU" }], 1_000);
    expect(readSnapshot("overview", 60_000, 30_000)).toEqual([{ symbol: "KABU" }]);
  });

  it("drops values older than maxAgeMs and unknown keys", () => {
    writeSnapshot("overview", [1], 1_000);
    expect(readSnapshot("overview", 60_000, 70_000)).toBeUndefined();
    expect(readSnapshot("missing", 60_000, 1_000)).toBeUndefined();
  });

  it("works without window (server render)", () => {
    expect(() => writeSnapshot("k", 1)).not.toThrow();
    expect(readSnapshot("k", 1_000)).toBe(1);
  });
});
