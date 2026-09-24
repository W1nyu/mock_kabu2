const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** KST 자정(= UTC 15:00 전날)을 UTC Date로. 거래소의 "당일" 집계 경계. */
export function koreaDayStart(now = Date.now()): Date {
  const shifted = new Date(now + KST_OFFSET_MS);
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - KST_OFFSET_MS);
}

/** 24시간 거래하는 모의 시장의 세션 시작: 매일 09:00 KST (= 00:00 UTC). */
export function koreaSessionStart(now = Date.now()): Date {
  const date = new Date(now);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}
