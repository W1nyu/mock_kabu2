const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** KST 자정(= UTC 15:00 전날)을 UTC Date로. 거래소의 "당일" 집계 경계. */
export function koreaDayStart(now = Date.now()): Date {
  const shifted = new Date(now + KST_OFFSET_MS);
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - KST_OFFSET_MS);
}
