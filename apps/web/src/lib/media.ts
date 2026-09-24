import { useSyncExternalStore } from "react";

/** 거래 화면이 폰 배치(차트 + 하단 매수/매도 버튼)로 바뀌는 폭. Tailwind `lg` 미만과 같다. */
export const COMPACT_TRADE_QUERY = "(max-width: 1023.98px)";

/**
 * 미디어 쿼리 일치 여부. 서버 렌더와 첫 hydration에서는 알 수 없으므로 null을 돌려준다 —
 * 호출자는 null일 때 어느 배치도 확정하지 않아야 hydration 불일치가 없다.
 */
export function useMediaQuery(query: string): boolean | null {
  return useSyncExternalStore(
    (onChange) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
    () => null,
  );
}
