import type { SymbolDef } from "@mock-kabu/shared";
import type { MarketModel, RandomSource } from "../market-model";
import { templateById } from "./catalog";
import { generateMacroNews, generateSequel, generateSymbolNews, type GeneratorContext } from "./generator";
import { RecentNewsMemory } from "./memory";
import { randomInt, unitRandom, type Range } from "./random";
import type { FollowUpOutcome, NewsItem, NewsSink } from "./types";

/** 종목 뉴스 4~8분, 매크로 30~60분. (처음엔 절반이었는데 너무 잦아 두 배로 늘렸다.) */
const DEFAULT_SYMBOL_GAP: Range = { min: 240_000, max: 480_000 };
const DEFAULT_MACRO_GAP: Range = { min: 1_800_000, max: 3_600_000 };
/** Two stories must never land in the same second; the feed has to stay readable. */
const DEFAULT_MIN_PUBLISH_GAP_MS = 20_000;
/** A symbol that just made news is skipped so one name cannot dominate. */
const DEFAULT_SYMBOL_COOLDOWN_MS = 360_000;
/** After a market-wide story, hold company news briefly so attribution is clear. */
const DEFAULT_MACRO_MUTE_MS = 120_000;
/**
 * Extra company stories for symbols under an admin scenario, on top of the
 * ordinary stream. Divided by the strongest current pressure, so full pressure
 * adds one every 6–14 minutes and the weakest level one every 15–35 minutes.
 */
const SCENARIO_GAP: Range = { min: 360_000, max: 840_000 };
/** Pressure this small is a ramp edge; it does not earn its own stories. */
const MIN_SCENARIO_STREAM_PRESSURE = 0.05;

export const NEWS_TICK_MS = 5_000;

export interface NewsSchedulerOptions {
  readonly random?: RandomSource;
  readonly symbolGapMs?: Range;
  readonly macroGapMs?: Range;
  readonly minPublishGapMs?: number;
  readonly symbolCooldownMs?: number;
  readonly macroMuteMs?: number;
  /** Signed admin-scenario pressure per symbol at a given time. Defaults to none. */
  readonly pressure?: (symbol: string, nowMs: number) => number;
}

interface PendingFollowUp {
  dueAtMs: number;
  parent: NewsItem;
  outcome: FollowUpOutcome;
}

/**
 * Drives three news streams off one tick.
 *
 * `tick(nowMs)` is a pure function of the injected clock, the injected
 * RandomSource and internal state, so a test can simulate an hour in a loop
 * and assert the exact sequence of headlines.
 */
export class NewsScheduler {
  private readonly random: RandomSource;
  private readonly memory = new RecentNewsMemory();
  private readonly symbolGapMs: Range;
  private readonly macroGapMs: Range;
  private readonly minPublishGapMs: number;
  private readonly symbolCooldownMs: number;
  private readonly macroMuteMs: number;
  private readonly pressure: (symbol: string, nowMs: number) => number;

  private readonly followUps: PendingFollowUp[] = [];
  private sequence = 0;
  private nextSymbolAtMs: number | null = null;
  private nextMacroAtMs: number | null = null;
  /** Pressure-weighted milliseconds since the last scenario story. */
  private scenarioAccruedMs = 0;
  private scenarioAccruedAtMs: number | null = null;
  private nextScenarioDueMs: number | null = null;
  private lastPublishedAtMs = Number.NEGATIVE_INFINITY;
  private lastMacroAtMs = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly model: MarketModel,
    private readonly symbols: readonly SymbolDef[],
    private readonly sink: NewsSink,
    options: NewsSchedulerOptions = {},
  ) {
    this.random = options.random ?? { next: () => Math.random() };
    this.symbolGapMs = options.symbolGapMs ?? DEFAULT_SYMBOL_GAP;
    this.macroGapMs = options.macroGapMs ?? DEFAULT_MACRO_GAP;
    this.minPublishGapMs = options.minPublishGapMs ?? DEFAULT_MIN_PUBLISH_GAP_MS;
    this.symbolCooldownMs = options.symbolCooldownMs ?? DEFAULT_SYMBOL_COOLDOWN_MS;
    this.macroMuteMs = options.macroMuteMs ?? DEFAULT_MACRO_MUTE_MS;
    this.pressure = options.pressure ?? (() => 0);
  }

  pendingFollowUpCount(): number {
    return this.followUps.length;
  }

  /** Publishes at most one item and applies its price impacts. */
  tick(nowMs: number = Date.now()): NewsItem | null {
    if (this.nextSymbolAtMs === null) {
      this.nextSymbolAtMs = nowMs + randomInt(this.random, this.symbolGapMs.min, this.symbolGapMs.max);
    }
    if (this.nextMacroAtMs === null) {
      this.nextMacroAtMs = nowMs + randomInt(this.random, this.macroGapMs.min, this.macroGapMs.max);
    }

    if (nowMs - this.lastPublishedAtMs < this.minPublishGapMs) return null;

    // A late sequel reads as a broken story; a company headline slipping five
    // seconds reads as nothing. Macro beats symbol because it is the rarer
    // stream, so delaying it distorts its cadence proportionally more.
    return (
      this.tryFollowUp(nowMs) ??
      this.tryMacro(nowMs) ??
      this.trySymbol(nowMs) ??
      this.tryScenario(nowMs)
    );
  }

  private context(nowMs: number): GeneratorContext {
    const sidewaysScores = new Map(
      this.symbols.map((symbol) => [symbol.symbol, this.model.sidewaysScore(symbol.symbol)]),
    );
    const prices = new Map(
      this.symbols.map((symbol) => [symbol.symbol, this.model.get(symbol.symbol)]),
    );
    return {
      nowMs,
      random: this.random,
      symbols: this.symbols,
      sidewaysScores,
      prices,
      memory: this.memory,
      nextSequence: () => ++this.sequence,
      pressure: (symbol) => this.pressure(symbol, nowMs),
    };
  }

  private tryFollowUp(nowMs: number): NewsItem | null {
    const index = this.followUps.findIndex((pending) => pending.dueAtMs <= nowMs);
    if (index < 0) return null;

    const [pending] = this.followUps.splice(index, 1);
    const item = generateSequel(this.context(nowMs), pending.parent, pending.outcome);
    return item ? this.publish(item, nowMs) : null;
  }

  private tryMacro(nowMs: number): NewsItem | null {
    if (this.nextMacroAtMs === null || nowMs < this.nextMacroAtMs) return null;

    const item = generateMacroNews(this.context(nowMs));
    if (!item) return null;

    this.nextMacroAtMs = nowMs + randomInt(this.random, this.macroGapMs.min, this.macroGapMs.max);
    this.lastMacroAtMs = nowMs;
    return this.publish(item, nowMs);
  }

  private trySymbol(nowMs: number): NewsItem | null {
    if (this.nextSymbolAtMs === null || nowMs < this.nextSymbolAtMs) return null;
    if (nowMs - this.lastMacroAtMs < this.macroMuteMs) return null;

    const item = generateSymbolNews(this.context(nowMs), this.eligibleSymbols(nowMs));
    if (!item) return null;

    this.nextSymbolAtMs = nowMs + randomInt(this.random, this.symbolGapMs.min, this.symbolGapMs.max);
    return this.publish(item, nowMs);
  }

  /**
   * The scenario stream: extra company stories drawn only from symbols under
   * pressure. It shares the per-symbol cooldown, so even a strong scenario
   * cannot put the same name in back-to-back headlines.
   */
  private tryScenario(nowMs: number): NewsItem | null {
    const pressured = this.symbols
      .map((symbol) => ({ symbol: symbol.symbol, pressure: Math.abs(this.pressure(symbol.symbol, nowMs)) }))
      .filter((entry) => entry.pressure >= MIN_SCENARIO_STREAM_PRESSURE);
    if (pressured.length === 0) {
      this.scenarioAccruedMs = 0;
      this.scenarioAccruedAtMs = null;
      this.nextScenarioDueMs = null;
      return null;
    }

    // Pressure-weighted time: a ramping or weak scenario accrues more slowly,
    // so the gap stretches with pressure without being fixed at a ramp edge.
    const strongest = Math.max(...pressured.map((entry) => entry.pressure));
    if (this.scenarioAccruedAtMs !== null) {
      this.scenarioAccruedMs += strongest * (nowMs - this.scenarioAccruedAtMs);
    }
    this.scenarioAccruedAtMs = nowMs;
    this.nextScenarioDueMs ??= randomInt(this.random, SCENARIO_GAP.min, SCENARIO_GAP.max);
    if (this.scenarioAccruedMs < this.nextScenarioDueMs) return null;
    if (nowMs - this.lastMacroAtMs < this.macroMuteMs) return null;

    const eligible = pressured
      .map((entry) => entry.symbol)
      .filter((symbol) => {
        const last = this.memory.lastSymbolPublishMs(symbol);
        return last === null || nowMs - last >= this.symbolCooldownMs;
      });
    // Every pressured symbol just made news; try again on a later tick.
    if (eligible.length === 0) return null;

    const item = generateSymbolNews(this.context(nowMs), eligible);
    if (!item) return null;

    this.scenarioAccruedMs = 0;
    this.nextScenarioDueMs = null;
    return this.publish(item, nowMs);
  }

  /** Cooled-down symbols are skipped, unless that would starve the stream. */
  private eligibleSymbols(nowMs: number): readonly string[] {
    const all = this.symbols.map((symbol) => symbol.symbol);
    const fresh = all.filter((symbol) => {
      const last = this.memory.lastSymbolPublishMs(symbol);
      return last === null || nowMs - last >= this.symbolCooldownMs;
    });
    return fresh.length > 0 ? fresh : all;
  }

  private publish(item: NewsItem, nowMs: number): NewsItem {
    // The price effect is applied first and never conditionally: a sink that
    // throws must not be able to swallow a market move that the feed will
    // later claim happened.
    for (const impact of item.impact) {
      this.model.startEvent(
        impact.symbol,
        impact.sentiment,
        impact.strength,
        impact.persistence,
        impact.volumeMultiplier,
      );
    }

    this.memory.record(item);
    this.lastPublishedAtMs = nowMs;
    this.scheduleFollowUp(item, nowMs);

    try {
      void this.sink.publish(item);
    } catch (error) {
      console.error("[news] sink failed", error);
    }
    return item;
  }

  private scheduleFollowUp(item: NewsItem, nowMs: number): void {
    const spec = templateById(item.templateId)?.followUp;
    if (!spec) return;
    if (unitRandom(this.random) >= (spec.chance ?? 1)) return;

    const roll = unitRandom(this.random);
    let cursor = 0;
    let chosen: FollowUpOutcome | null = null;
    for (const outcome of spec.outcomes) {
      cursor += outcome.probability;
      if (roll < cursor) {
        chosen = outcome;
        break;
      }
    }
    chosen ??= spec.outcomes.at(-1) ?? null;
    if (!chosen) return;

    let dueAtMs = nowMs + randomInt(this.random, spec.delayMs.min, spec.delayMs.max);
    // Nudge past an already-due sibling so two sequels do not contend.
    while (this.followUps.some((pending) => Math.abs(pending.dueAtMs - dueAtMs) < this.minPublishGapMs)) {
      dueAtMs += this.minPublishGapMs;
    }
    this.followUps.push({ dueAtMs, parent: item, outcome: chosen });
  }
}

export function startNewsEngine(
  model: MarketModel,
  symbols: readonly SymbolDef[],
  sink: NewsSink,
  options: NewsSchedulerOptions = {},
): { stop(): void } {
  const scheduler = new NewsScheduler(model, symbols, sink, options);
  const timer = setInterval(() => scheduler.tick(), NEWS_TICK_MS);
  timer.unref?.();
  return {
    stop() {
      clearInterval(timer);
    },
  };
}
