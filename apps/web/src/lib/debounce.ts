/**
 * 트레일링 디바운스. 계정 채널 push는 한 시장가 주문이 5단을 관통하면 5번 연달아 오는데, 각 컴포넌트가
 * push마다 REST를 다시 부르면 한 번의 체결에 수십 요청이 나간다. 마지막 push 뒤 `waitMs`가 지나면 한 번만
 * 실행한다. `cancel()`은 언마운트 시 대기 중인 호출을 버린다.
 */
export function debounce<A extends unknown[]>(fn: (...args: A) => void, waitMs: number) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const debounced = (...args: A) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, waitMs);
  };
  debounced.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  return debounced;
}

/** 계정 push 뒤 재조회까지 기다리는 시간. 체결 묶음이 끝난 뒤 한 번만 읽기에 충분하다. */
export const ACCOUNT_REFRESH_DEBOUNCE_MS = 400;
