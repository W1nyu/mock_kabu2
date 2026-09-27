/**
 * 목록 화면의 마지막 응답을 탭 안에 보관한다(메모리 + sessionStorage). 화면을 다시 열거나 새로고침하면
 * 서버 응답을 기다리지 않고 이 값을 먼저 그리고, 곧 도착하는 새 응답으로 바꾼다.
 * 탭 단위라 다른 계정·다른 탭과 섞이지 않고, 오래된 값은 maxAgeMs로 버린다.
 */
const PREFIX = "mock-kabu2:snap:";

/** 대시보드·증권 화면이 함께 쓰는 키 — 한쪽에서 받은 값을 다른 화면도 바로 그린다. */
export const SNAP_OVERVIEW = "market:overview";
export const SNAP_SPARKS = "market:sparks";
/** 목록 스냅샷은 10분 넘으면 버린다. */
export const SNAPSHOT_MAX_AGE_MS = 10 * 60_000;
const memory = new Map<string, { at: number; value: unknown }>();

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function readSnapshot<T>(key: string, maxAgeMs: number, now = Date.now()): T | undefined {
  let entry = memory.get(key);
  if (!entry) {
    try {
      const raw = storage()?.getItem(PREFIX + key);
      if (raw) {
        entry = JSON.parse(raw) as { at: number; value: unknown };
        memory.set(key, entry);
      }
    } catch {
      // 손상된 값은 무시한다.
    }
  }
  if (!entry || typeof entry.at !== "number" || now - entry.at > maxAgeMs) return undefined;
  return entry.value as T;
}

export function writeSnapshot(key: string, value: unknown, now = Date.now()): void {
  const entry = { at: now, value };
  memory.set(key, entry);
  try {
    storage()?.setItem(PREFIX + key, JSON.stringify(entry));
  } catch {
    // 저장 공간이 없어도 메모리 사본으로 충분하다.
  }
}

/** 테스트용 */
export function clearSnapshots(): void {
  memory.clear();
}
