import type { NewsItemDto } from "@mock-kabu/shared";
import { formatKstHm, formatKstMonthDay, isSameKstDay } from "./time";

export const MAX_NEWS_ITEMS = 60;

/**
 * The REST snapshot and the websocket push overlap, and a reconnect can replay
 * an item. Keep one row per id, newest first, capped — the same shape
 * TradesFeed uses for ticks.
 */
export function mergeNews(...sources: NewsItemDto[][]): NewsItemDto[] {
  const seen = new Set<string>();
  return sources
    .flat()
    .filter((item) => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    })
    .sort((left, right) => right.ts - left.ts)
    .slice(0, MAX_NEWS_ITEMS);
}

export function parseNewsItem(data: unknown): NewsItemDto | null {
  if (!data || typeof data !== "object") return null;
  const item = data as Partial<NewsItemDto>;
  if (typeof item.id !== "string" || item.id.length === 0) return null;
  if (typeof item.headline !== "string" || item.headline.length === 0) return null;
  if (!Number.isFinite(item.ts)) return null;
  if (item.symbol !== null && typeof item.symbol !== "string") return null;
  return item as NewsItemDto;
}

/**
 * News spans days, unlike the trade tape. Show a time for today, a date
 * otherwise, so a stale item can never masquerade as a fresh one. "Today" is
 * the KST trading day, not the viewer's.
 */
export function formatNewsTime(ts: number, now: number = Date.now()): string {
  if (!Number.isFinite(ts)) return "--:--";
  const time = formatKstHm(ts);
  return isSameKstDay(ts, now) ? time : `${formatKstMonthDay(ts)} ${time}`;
}
