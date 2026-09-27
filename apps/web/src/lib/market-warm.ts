import { sharedGet } from "./api";
import { readSnapshot, SNAP_OVERVIEW, SNAPSHOT_MAX_AGE_MS, writeSnapshot } from "./snapshot";
import { kstSessionStartMs } from "./time";

/** 현재 화면의 요청이 먼저 나가도록 조금 뒤에 받는다. */
const WARM_DELAY_MS = 1_500;

/**
 * 이 탭에 종목 목록 스냅샷이 없으면 한 번 받아 둔다. 다른 화면에 있다가 증권·대시보드·종목 화면으로
 * 옮겨 가도 목록을 기다리지 않는다. 대시보드·증권 화면이 이미 받아 둔 경우엔 아무것도 하지 않는다.
 */
export function warmMarketSnapshot(): () => void {
  const timer = setTimeout(() => {
    if (readSnapshot(SNAP_OVERVIEW, SNAPSHOT_MAX_AGE_MS)) return;
    sharedGet<{ sessionStart: number }[]>("/market/overview")
      .then((rows) => {
        if (rows.length && rows.every((row) => row.sessionStart >= kstSessionStartMs())) writeSnapshot(SNAP_OVERVIEW, rows);
      })
      .catch(() => {});
  }, WARM_DELAY_MS);
  return () => clearTimeout(timer);
}
