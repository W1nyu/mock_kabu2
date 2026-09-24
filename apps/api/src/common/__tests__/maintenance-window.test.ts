import { afterEach, describe, expect, it } from "vitest";
import {
  assertTradingOpen,
  maintenanceWindow,
  parseManualMaintenance,
  setManualMaintenance,
  upcomingManualMaintenance,
} from "../maintenance-window";

afterEach(() => setManualMaintenance(null));

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

describe("manual maintenance", () => {
  const raw = JSON.stringify({
    startAt: "2026-09-24T10:30:00Z",
    endAt: "2026-09-24T11:00:00Z",
    message: "서버 업그레이드 중입니다",
  });

  it("announces before it starts, then blocks trading with its own message until it ends", () => {
    setManualMaintenance(parseManualMaintenance(raw));
    const before = Date.parse("2026-09-24T10:25:00Z");
    const during = Date.parse("2026-09-24T10:40:00Z");
    const after = Date.parse("2026-09-24T11:00:00Z");

    expect(upcomingManualMaintenance(before)?.message).toBe("서버 업그레이드 중입니다");
    expect(maintenanceWindow(before).active).toBe(false);
    expect(() => assertTradingOpen(before)).not.toThrow();

    expect(upcomingManualMaintenance(during)).toBeNull();
    expect(maintenanceWindow(during)).toMatchObject({ active: true, manual: true, message: "서버 업그레이드 중입니다" });
    expect(() => assertTradingOpen(during)).toThrow(/서버 업그레이드/);

    expect(maintenanceWindow(after).active).toBe(false);
    expect(() => assertTradingOpen(after)).not.toThrow();
  });

  it("ignores malformed values instead of blocking trading", () => {
    expect(parseManualMaintenance(null)).toBeNull();
    expect(parseManualMaintenance("not json")).toBeNull();
    expect(parseManualMaintenance(JSON.stringify({ startAt: "2026-09-24T11:00:00Z", endAt: "2026-09-24T10:00:00Z" }))).toBeNull();
    expect(parseManualMaintenance(JSON.stringify({ startAt: "2026-09-24T10:00:00Z", endAt: "2026-09-24T11:00:00Z" }))?.message).toMatch(/점검/);
  });
});
