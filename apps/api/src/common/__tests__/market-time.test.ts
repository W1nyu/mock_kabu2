import { describe, expect, it } from "vitest";
import { koreaSessionStart } from "../market-time";

describe("koreaSessionStart", () => {
  it("changes at 09:00 KST, including across month boundaries", () => {
    expect(koreaSessionStart(Date.parse("2026-09-30T23:59:59.999Z")).toISOString()).toBe("2026-09-30T00:00:00.000Z");
    expect(koreaSessionStart(Date.parse("2026-10-01T00:00:00.000Z")).toISOString()).toBe("2026-10-01T00:00:00.000Z");
  });
});
