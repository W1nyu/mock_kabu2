"use client";

import { useEffect, useRef, useState } from "react";
import { advanceBookScale, ORDERBOOK_SCALE_HOLD_MS, type BookScale } from "./orderbook-scale";

export function useOrderbookScale(symbol: string, observed: number | null): number {
  const current = useRef<{ symbol: string; scale: BookScale | null }>({ symbol, scale: null });
  const [display, setDisplay] = useState<{ symbol: string; value: number } | null>(null);

  useEffect(() => {
    if (current.current.symbol !== symbol) current.current = { symbol, scale: null };
    if (observed == null) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      const now = performance.now();
      let next = advanceBookScale(current.current.scale, observed, now);
      // A confirmed conservative candidate can still differ from the latest
      // quantity. Start another window so a quiet book eventually converges.
      if (!next.pending && next.value !== observed) next = advanceBookScale(next, observed, now);
      current.current.scale = next;
      setDisplay((previous) => previous?.symbol === symbol && previous.value === next.value
        ? previous : { symbol, value: next.value });
      if (next.pending) {
        timer = setTimeout(update, Math.max(1, ORDERBOOK_SCALE_HOLD_MS - (now - next.pending.since)));
      }
    };
    update();
    return () => clearTimeout(timer);
  }, [symbol, observed]);

  // A newly selected symbol must never inherit another symbol's share scale.
  return display?.symbol === symbol ? display.value : observed ?? 1;
}
