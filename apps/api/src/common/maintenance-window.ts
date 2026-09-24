import { ServiceUnavailableException } from "@nestjs/common";

const DAY_MS = 24 * 60 * 60 * 1000;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const START_MINUTE_KST = 4 * 60 + 10;
const DURATION_MS = 10 * 60 * 1000;

/** 운영자가 Redis에 거는 임시 점검 (서버 교체·종목 추가 등). `ManualMaintenanceWatcher`가 채운다. */
export interface ManualMaintenance {
  startAt: number;
  endAt: number;
  message: string;
}

let manual: ManualMaintenance | null = null;

export function setManualMaintenance(next: ManualMaintenance | null): void {
  manual = next;
}

/** 아직 시작 전인 임시 점검 — 화면 배너로 미리 알린다. */
export function upcomingManualMaintenance(now = Date.now()): ManualMaintenance | null {
  return manual && now < manual.startAt ? manual : null;
}

function activeManual(now: number): ManualMaintenance | null {
  return manual && now >= manual.startAt && now < manual.endAt ? manual : null;
}

/**
 * Daily 04:10–04:20 KST trading pause, or an operator's manual maintenance
 * while it is in force. UTC arithmetic avoids host timezone drift.
 */
export function maintenanceWindow(now = Date.now()) {
  const current = activeManual(now);
  if (current) {
    return {
      active: true,
      startAt: new Date(current.startAt).toISOString(),
      endAt: new Date(current.endAt).toISOString(),
      timezone: "Asia/Seoul",
      manual: true,
      message: current.message,
    };
  }
  const kstDay = Math.floor((now + KST_OFFSET_MS) / DAY_MS);
  const start = kstDay * DAY_MS + START_MINUTE_KST * 60_000 - KST_OFFSET_MS;
  const end = start + DURATION_MS;
  const active = now >= start && now < end;
  return {
    active,
    startAt: new Date(active ? start : now < start ? start : start + DAY_MS).toISOString(),
    endAt: new Date(active ? end : now < start ? end : end + DAY_MS).toISOString(),
    timezone: "Asia/Seoul",
    manual: false,
    message: null as string | null,
  };
}

export function assertTradingOpen(now = Date.now()): void {
  const current = activeManual(now);
  if (current) throw new ServiceUnavailableException(current.message);
  const window = maintenanceWindow(now);
  if (window.active) {
    throw new ServiceUnavailableException("매일 04:10~04:20(한국 시간)은 점검 시간입니다. 04:20 이후 다시 시도해 주세요.");
  }
}

/** Redis 값(JSON)을 검증해 임시 점검으로 바꾼다. 잘못된 값은 무시한다(점검 없음). */
export function parseManualMaintenance(raw: string | null): ManualMaintenance | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as { startAt?: unknown; endAt?: unknown; message?: unknown };
    const startAt = Date.parse(String(value.startAt));
    const endAt = Date.parse(String(value.endAt));
    if (!Number.isFinite(startAt) || !Number.isFinite(endAt) || endAt <= startAt) return null;
    const message =
      typeof value.message === "string" && value.message.trim()
        ? value.message.trim().slice(0, 200)
        : "서버 점검 중입니다. 잠시 후 다시 이용해 주세요.";
    return { startAt, endAt, message };
  } catch {
    return null;
  }
}
