/**
 * 실시간 체결을 잠깐(intervalMs) 모았다가 한 번에 반영한다. 전 종목 체결은 초당 수십 건이라
 * 건마다 setState하면 목록 전체가 그만큼 다시 그려진다 — 모아서 초당 몇 번만 그린다.
 */
export function createTickBatcher<T>(apply: (items: T[]) => void, intervalMs = 200) {
  let buffer: T[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    timer = null;
    const items = buffer;
    buffer = [];
    if (items.length) apply(items);
  };
  return {
    push(item: T) {
      buffer.push(item);
      if (!timer) timer = setTimeout(flush, intervalMs);
    },
    /** 구독 해제 때 남은 것을 버린다(언마운트 뒤 setState 방지). */
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
      buffer = [];
    },
  };
}
