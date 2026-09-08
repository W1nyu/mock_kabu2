import type { NewsCategory, NewsItem, VocabKey } from "./types";

/** An exact template repeat inside this window is what a viewer notices first. */
export const TEMPLATE_COOLDOWN_MS = 45 * 60_000;
/** Three 증자 stories in a row read as broken even when the templates differ. */
export const CATEGORY_COOLDOWN_MS = 12 * 60_000;
const SYMBOL_FAIRNESS_WINDOW_MS = 60 * 60_000;

const TEMPLATE_PENALTY = 0.05;
const CATEGORY_PENALTY = 0.25;

const RENDER_HISTORY_SIZE = 40;
const VOCAB_HISTORY_SIZE = 6;

/**
 * Recency state for the news generator.
 *
 * Every penalty is a multiplier that shrinks a weight rather than removing a
 * candidate, so no combination of cooldowns can empty the pool and deadlock
 * the scheduler.
 */
export class RecentNewsMemory {
  private readonly templateUsedAt = new Map<string, number>();
  private readonly categoryUsedAt = new Map<NewsCategory, number>();
  private readonly symbolUsedAt = new Map<string, number[]>();
  private readonly headlineIndex = new Map<string, number>();
  private readonly renderHistory: string[] = [];
  private readonly vocabHistory = new Map<VocabKey, string[]>();

  record(item: NewsItem): void {
    this.templateUsedAt.set(item.templateId, item.publishedAtMs);
    this.categoryUsedAt.set(item.category, item.publishedAtMs);
    if (item.symbol) {
      const stamps = this.symbolUsedAt.get(item.symbol) ?? [];
      stamps.push(item.publishedAtMs);
      this.symbolUsedAt.set(item.symbol, stamps);
    }
    this.noteRender(renderKey(item.templateId, item.slotValues));
  }

  templatePenalty(templateId: string, nowMs: number): number {
    const usedAt = this.templateUsedAt.get(templateId);
    if (usedAt === undefined) return 1;
    return nowMs - usedAt < TEMPLATE_COOLDOWN_MS ? TEMPLATE_PENALTY : 1;
  }

  categoryPenalty(category: NewsCategory, nowMs: number): number {
    const usedAt = this.categoryUsedAt.get(category);
    if (usedAt === undefined) return 1;
    return nowMs - usedAt < CATEGORY_COOLDOWN_MS ? CATEGORY_PENALTY : 1;
  }

  /** Sideways targeting still steers the feed, but no symbol can monopolise it. */
  symbolPenalty(symbol: string, nowMs: number): number {
    return 1 / (1 + this.recentSymbolCount(symbol, nowMs));
  }

  recentSymbolCount(symbol: string, nowMs: number): number {
    const stamps = this.symbolUsedAt.get(symbol);
    if (!stamps) return 0;
    const fresh = stamps.filter((stamp) => nowMs - stamp < SYMBOL_FAIRNESS_WINDOW_MS);
    this.symbolUsedAt.set(symbol, fresh);
    return fresh.length;
  }

  lastSymbolPublishMs(symbol: string): number | null {
    const stamps = this.symbolUsedAt.get(symbol);
    return stamps && stamps.length > 0 ? stamps[stamps.length - 1] : null;
  }

  /**
   * Rotate through a template's headline variants rather than re-rolling, so
   * even a repeated template reads differently.
   */
  nextHeadlineIndex(templateId: string, variantCount: number): number {
    if (variantCount <= 1) return 0;
    const previous = this.headlineIndex.get(templateId);
    const next = previous === undefined ? 0 : (previous + 1) % variantCount;
    this.headlineIndex.set(templateId, next);
    return next;
  }

  isDuplicateRender(key: string): boolean {
    return this.renderHistory.includes(key);
  }

  noteRender(key: string): void {
    this.renderHistory.push(key);
    if (this.renderHistory.length > RENDER_HISTORY_SIZE) this.renderHistory.shift();
  }

  recentVocabPicks(vocab: VocabKey): readonly string[] {
    return this.vocabHistory.get(vocab) ?? [];
  }

  noteVocabPick(vocab: VocabKey, value: string): void {
    const history = this.vocabHistory.get(vocab) ?? [];
    history.push(value);
    if (history.length > VOCAB_HISTORY_SIZE) history.shift();
    this.vocabHistory.set(vocab, history);
  }
}

export function renderKey(templateId: string, slotValues: Readonly<Record<string, string>>): string {
  const parts = Object.entries(slotValues)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`);
  return `${templateId}|${parts.join("&")}`;
}
