/**
 * 필터 상태를 주소창 쿼리에 남긴다(뒤로 가기·공유 시 유지). useSearchParams는 Suspense 경계가
 * 필요해, 클라이언트 페이지에서는 마운트 뒤 직접 읽고 replaceState로만 고친다.
 */
export function readQueryParam(key: string): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get(key);
}

export function writeQueryParams(values: Record<string, string | null>): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  for (const [key, value] of Object.entries(values)) {
    if (value === null) url.searchParams.delete(key);
    else url.searchParams.set(key, value);
  }
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}
