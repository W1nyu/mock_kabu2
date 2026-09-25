import {
  COMMODITY_REFERENCE_WEIGHTS,
  industryOf,
  referenceNewsMove,
  type ReferenceCode,
  type SymbolDef,
} from "@mock-kabu/shared";
import {
  MAX_EVENT_STRENGTH,
  MIN_EVENT_STRENGTH,
  pressuredSentimentFromRoll,
  sidewaysEventTargetWeight,
  type MarketEventSentiment,
  type RandomSource,
} from "../market-model";
import { MACRO_POOL, SECTOR_POOL, SYMBOL_POOL, templateById } from "./catalog";
import { companyProfile, MIN_MACRO_BETA } from "./company-profiles";
import { RecentNewsMemory, renderKey } from "./memory";
import { clamp, pickOne, triangular, unitRandom, uniform, weightedPick } from "./random";
import { bindSlots, renderTemplate, type SlotContext } from "./slots";
import type { FollowUpOutcome, NewsImpact, NewsItem, NewsTemplate, SectorTag } from "./types";

/** How many times a duplicate render is resampled before it is accepted anyway. */
const MAX_RESAMPLE_ATTEMPTS = 4;
/** Per-symbol variation applied to a market-wide story. */
const MACRO_JITTER = { min: 0.88, max: 1.12 };
/** Per-symbol variation applied to an industry story. */
const SECTOR_JITTER = { min: 0.85, max: 1.15 };
/** An exposure weaker than this is not worth a separate print for that listing. */
const MIN_SECTOR_EXPOSURE = 0.15;
/** Macro impulses outlive flow news but not a balance-sheet event. */
const MACRO_PERSISTENCE = { min: 0.93, max: 0.955 };
/** At full scenario pressure a symbol is this much more likely to be the next story (1 + boost). */
const SCENARIO_TARGET_BOOST = 1.5;
/** At full pressure a story in the scenario's direction lands up to 30% harder. */
const SCENARIO_STRENGTH_BOOST = 0.3;

export interface GeneratorContext {
  readonly nowMs: number;
  readonly random: RandomSource;
  readonly symbols: readonly SymbolDef[];
  readonly sidewaysScores: ReadonlyMap<string, number>;
  readonly prices: ReadonlyMap<string, number>;
  readonly memory: RecentNewsMemory;
  readonly nextSequence: () => number;
  /** Signed admin-scenario pressure per symbol. Absent or 0 leaves every draw unchanged. */
  readonly pressure?: (symbol: string) => number;
  /** 선물 기초자산의 지금 실제 값 — 기사 속 환율·유가 숫자를 실제 가격에 맞춘다. 없으면 템플릿 범위에서 뽑는다. */
  readonly referenceValue?: (code: ReferenceCode) => number | null;
}

/** 템플릿·{commodity}로 이 기사가 움직일 기초자산 가중치 */
export function referenceWeights(
  template: NewsTemplate,
  slotValues: Readonly<Record<string, string>>,
): [ReferenceCode, number][] {
  const spec = template.referenceMoves;
  if (!spec) return [];
  const weights = spec === "commodity" ? (COMMODITY_REFERENCE_WEIGHTS[slotValues.commodity ?? ""] ?? {}) : spec;
  return (Object.entries(weights) as [ReferenceCode, number][]).filter(([, weight]) => weight !== 0);
}

function flip(sentiment: MarketEventSentiment): MarketEventSentiment {
  return sentiment === "POSITIVE" ? "NEGATIVE" : "POSITIVE";
}

function eligibleForSector(template: NewsTemplate, sector: SectorTag | null): boolean {
  if (!sector) return !template.sectors;
  if (template.excludeSectors?.includes(sector)) return false;
  return !template.sectors || template.sectors.includes(sector);
}

/**
 * Weighted template choice within one sentiment.
 *
 * Sentiment is fixed by the caller before this runs. That ordering keeps the
 * market's long-run positive/negative mix pinned to POSITIVE_EVENT_PROBABILITY
 * instead of drifting whenever someone adds templates to the catalog.
 */
export function selectTemplate(
  pool: readonly NewsTemplate[],
  sentiment: MarketEventSentiment,
  sector: SectorTag | null,
  ctx: GeneratorContext,
): NewsTemplate | null {
  const candidates = pool
    .filter((template) => template.sentiment === sentiment && eligibleForSector(template, sector))
    .map((template) => ({
      value: template,
      weight:
        (template.weight ?? 1) *
        ctx.memory.templatePenalty(template.id, ctx.nowMs) *
        ctx.memory.categoryPenalty(template.category, ctx.nowMs),
    }));
  return weightedPick(ctx.random, candidates);
}

function sampleStrength(template: NewsTemplate, random: RandomSource): number {
  return clamp(triangular(random, template.strength), MIN_EVENT_STRENGTH, MAX_EVENT_STRENGTH);
}

function optionalRange(
  range: { min: number; max: number } | undefined,
  random: RandomSource,
): number | undefined {
  return range ? uniform(random, range) : undefined;
}

/**
 * Render a template, retrying a few times when the exact same figures have
 * appeared recently. Bounded so a small vocabulary can never spin forever.
 */
function renderWithSlots(
  template: NewsTemplate,
  ctx: GeneratorContext,
  slotContext: SlotContext,
): { headline: string; body: string | null; slotValues: Record<string, string> } {
  let slotValues = bindSlots(template, slotContext);
  for (let attempt = 0; attempt < MAX_RESAMPLE_ATTEMPTS; attempt++) {
    if (!ctx.memory.isDuplicateRender(renderKey(template.id, slotValues))) break;
    slotValues = bindSlots(template, slotContext);
  }

  const index = ctx.memory.nextHeadlineIndex(template.id, template.headlines.length);
  const headline = renderTemplate(template.headlines[index], slotValues);
  const body = template.body?.length
    ? renderTemplate(pickOne(ctx.random, template.body), slotValues)
    : null;
  return { headline, body, slotValues };
}

function makeId(ctx: GeneratorContext, template: NewsTemplate): string {
  return `${ctx.nextSequence()}:${template.id}`;
}

export function generateSymbolNews(
  ctx: GeneratorContext,
  eligible: readonly string[],
): NewsItem | null {
  if (eligible.length === 0) return null;

  // 1. Symbol — the price model's own sideways weighting, multiplied by a
  //    fairness term. Composing the weight here rather than calling
  //    chooseWeightedEventTarget keeps the model's calibration intact: that
  //    helper re-weights whatever it is given, so feeding it an already
  //    fairness-adjusted score would distort the sideways curve.
  const targetSymbol = weightedPick(
    ctx.random,
    eligible.map((symbol) => ({
      value: symbol,
      weight:
        sidewaysEventTargetWeight(ctx.sidewaysScores.get(symbol) ?? 0) *
        ctx.memory.symbolPenalty(symbol, ctx.nowMs) *
        (1 + SCENARIO_TARGET_BOOST * Math.abs(ctx.pressure?.(symbol) ?? 0)),
    })),
  );
  const symbol = ctx.symbols.find((candidate) => candidate.symbol === targetSymbol);
  if (!symbol) return null;
  const profile = companyProfile(symbol.symbol);
  const pressure = ctx.pressure?.(symbol.symbol) ?? 0;

  // 2. Sentiment, before the template, so the catalog's shape cannot move the
  //    market's long-run drift. An admin scenario leans this roll only while
  //    it runs.
  const sentiment = pressuredSentimentFromRoll(unitRandom(ctx.random), pressure);

  // 3. Template, restricted to what this company could plausibly announce.
  const template = selectTemplate(SYMBOL_POOL, sentiment, profile?.sector ?? null, ctx);
  if (!template) return null;

  // 4. Strength, last, because only the template knows what magnitude is
  //    believable for this particular story. A story that goes the scenario's
  //    way lands harder; one against it keeps its ordinary size.
  const aligned = pressure !== 0 && (sentiment === "POSITIVE") === pressure > 0;
  const strength = aligned
    ? clamp(
        sampleStrength(template, ctx.random) * (1 + SCENARIO_STRENGTH_BOOST * Math.abs(pressure)),
        MIN_EVENT_STRENGTH,
        MAX_EVENT_STRENGTH,
      )
    : sampleStrength(template, ctx.random);

  const slotContext: SlotContext = {
    random: ctx.random,
    nowMs: ctx.nowMs,
    symbol,
    profile,
    price: ctx.prices.get(symbol.symbol) ?? symbol.initialPrice,
    memory: ctx.memory,
  };
  const { headline, body, slotValues } = renderWithSlots(template, ctx, slotContext);

  return {
    id: makeId(ctx, template),
    templateId: template.id,
    scope: "SYMBOL",
    category: template.category,
    symbol: symbol.symbol,
    industry: null,
    headline,
    body,
    publishedAtMs: ctx.nowMs,
    slotValues,
    parentItemId: null,
    impact: [
      {
        symbol: symbol.symbol,
        sentiment: template.sentiment,
        strength,
        persistence: optionalRange(template.persistence, ctx.random),
        volumeMultiplier: optionalRange(template.volumeMultiplier, ctx.random),
      },
    ],
  };
}

export function generateMacroNews(ctx: GeneratorContext, forcedTemplateId?: string): NewsItem | null {
  // No sentiment filter here. A macro story's direction per symbol comes from
  // macroDirection x beta, so pre-filtering by the template's market-average
  // label would double-count the direction and could contradict the impacts.
  // The macro pool is built in up/down pairs, which keeps the mix balanced.
  // forcedTemplateId: 운영자가 즉시 발행을 요청한 템플릿(없는 id면 null).
  const template = forcedTemplateId
    ? (MACRO_POOL.find((candidate) => candidate.id === forcedTemplateId) ?? null)
    : weightedPick(
    ctx.random,
    MACRO_POOL.map((candidate) => ({
      value: candidate,
      weight:
        (candidate.weight ?? 1) *
        ctx.memory.templatePenalty(candidate.id, ctx.nowMs) *
        ctx.memory.categoryPenalty(candidate.category, ctx.nowMs),
    })),
  );
  if (!template) return null;

  const macroStrength = sampleStrength(template, ctx.random);
  const direction = template.macroDirection ?? 1;
  const slotContext: SlotContext = {
    random: ctx.random,
    nowMs: ctx.nowMs,
    symbol: null,
    profile: null,
    price: null,
    memory: ctx.memory,
    // 기사 속 환율·유가·등락률을 대표 기초자산의 실제 값과 이 기사가 만들 움직임으로 채운다.
    referencePlan: (bound) => {
      // 기사가 직접 말하는 자산(가중치 1)만 숫자에 쓴다 — "니켈 급등" 기사에 구리 등락률이 찍히지 않게.
      const [primary] = referenceWeights(template, bound).filter(([, weight]) => Math.abs(weight) >= 1);
      if (!primary) return null;
      const current = ctx.referenceValue?.(primary[0]) ?? null;
      if (current == null || !(current > 0)) return null;
      return { code: primary[0], current, move: referenceNewsMove(primary[0], primary[1], direction, macroStrength) };
    },
  };
  const { headline, body, slotValues } = renderWithSlots(template, ctx, slotContext);
  const referenceMoves = referenceWeights(template, slotValues).map(([code, weight]) => ({
    code,
    move: referenceNewsMove(code, weight, direction, macroStrength),
  }));

  const channel = template.macroChannel;
  const impact: NewsImpact[] = [];
  if (channel) {
    for (const symbol of ctx.symbols) {
      const profile = companyProfile(symbol.symbol);
      const beta = profile?.macroBeta[channel] ?? 0;
      // Too insensitive to be worth a separate print for this listing.
      if (Math.abs(beta) < MIN_MACRO_BETA) continue;

      // "The won rose" is a fact; whether that is good news depends on the
      // company. A rising won/dollar rate lifts the exporters and hurts the
      // brokerage from the same headline, exactly as it splits a real market.
      const effect = direction * beta;
      impact.push({
        symbol: symbol.symbol,
        sentiment: effect >= 0 ? "POSITIVE" : "NEGATIVE",
        strength: clamp(
          macroStrength * Math.abs(beta) * uniform(ctx.random, MACRO_JITTER),
          MIN_EVENT_STRENGTH,
          MAX_EVENT_STRENGTH,
        ),
        persistence: uniform(ctx.random, MACRO_PERSISTENCE),
      });
    }
  }
  if (impact.length === 0) return null;

  return {
    id: makeId(ctx, template),
    templateId: template.id,
    scope: "MACRO",
    category: template.category,
    symbol: null,
    industry: null,
    headline,
    body,
    publishedAtMs: ctx.nowMs,
    slotValues,
    parentItemId: null,
    impact,
    ...(referenceMoves.length > 0 ? { referenceMoves } : {}),
  };
}

/**
 * An industry story. Like a macro story it names no company and is not filtered by
 * sentiment first — the sector pool is built in up/down pairs. Each listing's
 * direction is the template's sentiment, flipped where its sector weight is negative.
 */
export function generateSectorNews(ctx: GeneratorContext): NewsItem | null {
  const listed = new Set(ctx.symbols.map((symbol) => companyProfile(symbol.symbol)?.sector));
  const template = weightedPick(
    ctx.random,
    SECTOR_POOL.filter((candidate) =>
      Object.entries(candidate.sectorExposure ?? {}).some(
        ([sector, weight]) => (weight ?? 0) > 0 && listed.has(sector as SectorTag),
      ),
    ).map((candidate) => ({
      value: candidate,
      weight:
        (candidate.weight ?? 1) *
        ctx.memory.templatePenalty(candidate.id, ctx.nowMs) *
        ctx.memory.categoryPenalty(candidate.category, ctx.nowMs),
    })),
  );
  if (!template) return null;

  const baseStrength = sampleStrength(template, ctx.random);
  const slotContext: SlotContext = {
    random: ctx.random,
    nowMs: ctx.nowMs,
    symbol: null,
    profile: null,
    price: null,
    memory: ctx.memory,
  };
  const { headline, body, slotValues } = renderWithSlots(template, ctx, slotContext);

  const impact: NewsImpact[] = [];
  let lead: { symbol: string; weight: number } | null = null;
  for (const symbol of ctx.symbols) {
    const sector = companyProfile(symbol.symbol)?.sector;
    const weight = sector ? (template.sectorExposure?.[sector] ?? 0) : 0;
    if (Math.abs(weight) < MIN_SECTOR_EXPOSURE) continue;
    if (weight > 0 && (!lead || weight > lead.weight)) lead = { symbol: symbol.symbol, weight };
    impact.push({
      symbol: symbol.symbol,
      sentiment: weight > 0 ? template.sentiment : flip(template.sentiment),
      strength: clamp(
        baseStrength * Math.abs(weight) * uniform(ctx.random, SECTOR_JITTER),
        MIN_EVENT_STRENGTH,
        MAX_EVENT_STRENGTH,
      ),
      persistence: optionalRange(template.persistence, ctx.random),
      volumeMultiplier: optionalRange(template.volumeMultiplier, ctx.random),
    });
  }
  if (impact.length === 0 || !lead) return null;

  return {
    id: makeId(ctx, template),
    templateId: template.id,
    scope: "SECTOR",
    category: template.category,
    symbol: null,
    // Filed under the industry of the most exposed listing, so the story shows up
    // in that industry's feed and on its symbols' pages.
    industry: industryOf(lead.symbol)?.id ?? null,
    headline,
    body,
    publishedAtMs: ctx.nowMs,
    slotValues,
    parentItemId: null,
    impact,
  };
}

export function generateSequel(
  ctx: GeneratorContext,
  parent: NewsItem,
  outcome: FollowUpOutcome,
): NewsItem | null {
  const template = templateById(outcome.templateId);
  if (!template || !parent.symbol) return null;
  const symbol = ctx.symbols.find((candidate) => candidate.symbol === parent.symbol);
  if (!symbol) return null;

  const parentImpact = parent.impact.find((entry) => entry.symbol === parent.symbol);
  if (!parentImpact) return null;

  const sentiment =
    outcome.polarity === "TEMPLATE"
      ? template.sentiment
      : outcome.polarity === "REVERSE"
        ? flip(parentImpact.sentiment)
        : parentImpact.sentiment;

  const scaled = parentImpact.strength * (outcome.strengthScale ?? 1);
  const strength = clamp(
    clamp(scaled, template.strength.min, template.strength.max),
    MIN_EVENT_STRENGTH,
    MAX_EVENT_STRENGTH,
  );

  const slotContext: SlotContext = {
    random: ctx.random,
    nowMs: ctx.nowMs,
    symbol,
    profile: companyProfile(symbol.symbol),
    price: ctx.prices.get(symbol.symbol) ?? symbol.initialPrice,
    memory: ctx.memory,
    // The sequel keeps the parent's figures so it reads as the same story.
    inherited: parent.slotValues,
  };
  const { headline, body, slotValues } = renderWithSlots(template, ctx, slotContext);

  return {
    id: makeId(ctx, template),
    templateId: template.id,
    scope: "SYMBOL",
    category: template.category,
    symbol: symbol.symbol,
    industry: null,
    headline,
    body,
    publishedAtMs: ctx.nowMs,
    slotValues,
    parentItemId: parent.id,
    impact: [
      {
        symbol: symbol.symbol,
        sentiment,
        strength,
        persistence: optionalRange(template.persistence, ctx.random),
        volumeMultiplier: optionalRange(template.volumeMultiplier, ctx.random),
      },
    ],
  };
}
