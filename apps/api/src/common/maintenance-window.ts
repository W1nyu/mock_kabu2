import { ServiceUnavailableException } from "@nestjs/common";

const DAY_MS = 24 * 60 * 60 * 1000;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const START_MINUTE_KST = 4 * 60 + 10;
const DURATION_MS = 10 * 60 * 1000;

/** Daily 04:10–04:20 KST trading pause. UTC arithmetic avoids host timezone drift. */
export function maintenanceWindow(now = Date.now()) {
  const kstDay = Math.floor((now + KST_OFFSET_MS) / DAY_MS);
  const start = kstDay * DAY_MS + START_MINUTE_KST * 60_000 - KST_OFFSET_MS;
  const end = start + DURATION_MS;
  const active = now >= start && now < end;
  return {
    active,
    startAt: new Date(active ? start : now < start ? start : start + DAY_MS).toISOString(),
    endAt: new Date(active ? end : now < start ? end : end + DAY_MS).toISOString(),
    timezone: "Asia/Seoul",
  };
}

export function assertTradingOpen(now = Date.now()): void {
  const window = maintenanceWindow(now);
  if (window.active) {
    throw new ServiceUnavailableException("매일 04:10~04:20(한국 시간)은 점검 시간입니다. 04:20 이후 다시 시도해 주세요.");
  }
}
