import { describe, expect, it } from "vitest";
import { assertTradingOpen, maintenanceWindow } from "../maintenance-window";

describe("daily maintenance window", () => {
  it("opens at 04:10 KST and closes at 04:20 KST, regardless of server timezone", () => {
    const before = Date.parse("2026-09-22T19:09:59.999Z");
    const start = Date.parse("2026-09-22T19:10:00.000Z");
    const end = Date.parse("2026-09-22T19:20:00.000Z");
    expect(maintenanceWindow(before).active).toBe(false);
    expect(maintenanceWindow(start)).toMatchObject({
      active: true,
      startAt: "2026-09-22T19:10:00.000Z",
      endAt: "2026-09-22T19:20:00.000Z",
    });
    expect(maintenanceWindow(end).active).toBe(false);
    expect(() => assertTradingOpen(start)).toThrow(/점검 시간/);
    expect(() => assertTradingOpen(end)).not.toThrow();
  });

  it("returns tomorrow's next maintenance after today's window", () => {
    expect(maintenanceWindow(Date.parse("2026-09-22T19:21:00Z")).startAt)
      .toBe("2026-09-23T19:10:00.000Z");
  });
});
