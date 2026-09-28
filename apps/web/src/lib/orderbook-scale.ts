export const ORDERBOOK_VISIBLE_LEVELS = 8;
export const ORDERBOOK_SCALE_HOLD_MS = 800;

interface QuantityLevel { qty: number }

/** Only the rows actually drawn may determine the shared bid/ask scale. */
export function visibleBookMax(book: { asks: QuantityLevel[]; bids: QuantityLevel[] }): number {
  return Math.max(1, ...[...book.asks.slice(0, ORDERBOOK_VISIBLE_LEVELS),
    ...book.bids.slice(0, ORDERBOOK_VISIBLE_LEVELS)].map((level) => level.qty));
}

export interface BookScale {
  value: number;
  pending: { direction: 1 | -1; value: number; since: number } | null;
}

/** Confirm a sustained change, not a maker's short post-before-cancel overlap.
 * Keep the closest candidate to the current scale during the window: ordinary
 * quantity jitter must neither restart the clock nor confirm a fresh spike.
 */
export function advanceBookScale(state: BookScale | null, observed: number, now: number): BookScale {
  if (!state) return { value: observed, pending: null };
  if (observed === state.value) return { value: state.value, pending: null };
  const direction = observed > state.value ? 1 : -1;
  const previous = state.pending?.direction === direction ? state.pending : null;
  const pending = {
    direction,
    value: previous ? (direction === 1 ? Math.min(previous.value, observed) : Math.max(previous.value, observed)) : observed,
    since: previous?.since ?? now,
  } as const;
  if (now - pending.since >= ORDERBOOK_SCALE_HOLD_MS) {
    return { value: pending.value, pending: null };
  }
  return { value: state.value, pending };
}

export function bookBarWidth(qty: number, scale: number): number {
  return Math.min(100, Math.max(2, (qty / scale) * 100));
}
