import type { ReferenceCode, SymbolDef } from "@mock-kabu/shared";
import type { RandomSource } from "../market-model";
import type { CompanyProfile } from "./company-profiles";
import { isParticleKey, resolveParticle } from "./particles";
import { randomInt, uniform, weightedPick } from "./random";
import type { NewsTemplate, SlotSpec, VocabKey } from "./types";
import { vocabList } from "./vocab";

const groupFormatter = new Intl.NumberFormat("ko-KR");

function group(value: number): string {
  return groupFormatter.format(value);
}

/**
 * Round a 억원 figure to the precision a real filing would quote it at.
 * Bigger numbers are quoted coarser — nobody writes "3,247억원".
 */
export function roundEok(eok: number): number {
  if (!Number.isFinite(eok) || eok <= 0) return 1;
  if (eok >= 10_000) return Math.round(eok / 1_000) * 1_000;
  if (eok >= 1_000) return Math.round(eok / 100) * 100;
  if (eok >= 100) return Math.round(eok / 10) * 10;
  if (eok >= 10) return Math.round(eok / 5) * 5;
  return Math.max(1, Math.round(eok));
}

/**
 * Korean money rendering. Above 1조 the figure splits into 조 and a rounded
 * 억 remainder; rounding is applied before the split so a value just under
 * 1조 promotes cleanly ("9,960억" → "1조원") instead of printing "9,960억원"
 * next to a "1조 0억원" sibling.
 */
export function formatEok(eok: number): string {
  const value = roundEok(eok);
  if (value >= 10_000) {
    const jo = Math.floor(value / 10_000);
    const remainder = value % 10_000;
    return remainder === 0 ? `${jo}조원` : `${jo}조 ${group(remainder)}억원`;
  }
  return `${group(value)}억원`;
}

/** Round to two significant-ish digits so an analyst target reads round. */
export function roundNicePrice(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  const step = Math.max(1, 10 ** Math.max(0, Math.floor(Math.log10(raw)) - 1));
  return Math.round(raw / step) * step;
}

export function snapToTick(price: number, tickSize: number): number {
  const tick = Number.isFinite(tickSize) && tickSize > 0 ? tickSize : 1;
  return Math.max(tick, Math.round(price / tick) * tick);
}

/** Calendar quarter label, offset in whole quarters from `nowMs`. */
export function quarterLabel(nowMs: number, offsetQuarters: number): string {
  const date = new Date(nowMs);
  const index = date.getUTCFullYear() * 4 + Math.floor(date.getUTCMonth() / 3) + offsetQuarters;
  return `${(((index % 4) + 4) % 4) + 1}분기`;
}

/** The slice of RecentNewsMemory the slot sampler needs. */
export interface VocabMemory {
  recentVocabPicks(vocab: VocabKey): readonly string[];
  noteVocabPick(vocab: VocabKey, value: string): void;
}

export const NO_VOCAB_MEMORY: VocabMemory = {
  recentVocabPicks: () => [],
  noteVocabPick: () => {},
};

export interface SlotContext {
  readonly random: RandomSource;
  readonly nowMs: number;
  readonly symbol: SymbolDef | null;
  readonly profile: CompanyProfile | null;
  /** Live model price, needed for targetPrice. */
  readonly price: number | null;
  readonly memory: VocabMemory;
  /** A sequel reuses its parent's bindings so it reads as the same story. */
  readonly inherited?: Readonly<Record<string, string>>;
  /**
   * reference 슬롯용: 다른 슬롯을 다 채운 뒤(예: {commodity}) 이 기사가 움직일 대표 기초자산을 알려 준다.
   * 없거나 null이면 reference 슬롯은 range에서 무작위로 뽑는다.
   */
  readonly referencePlan?: (bound: Readonly<Record<string, string>>) => ReferenceSlotPlan | null;
}

/** 기사 속 가격·%를 실제 기초자산에 맞추기 위한 값 */
export interface ReferenceSlotPlan {
  readonly code: ReferenceCode;
  /** 지금 실제 값 */
  readonly current: number;
  /** 이 기사가 줄 로그 수익률 */
  readonly move: number;
}

/** "돌파/하락" 수준으로 쓸 눈금 — 큰 눈금부터, 지금 값과 도착 값 사이에 들어오는 첫 눈금을 쓴다. */
const LEVEL_STEPS: Readonly<Record<ReferenceCode, readonly number[]>> = {
  USDKRW: [10, 5, 1],
  OIL: [1, 0.5, 0.1],
  GAS: [1, 0.5, 0.1],
  COPPER: [1, 0.5, 0.1],
};

function formatLevel(value: number, decimals: number, unit: string): string {
  const rounded = Number(value.toFixed(decimals));
  const text =
    decimals === 0
      ? group(rounded)
      : `${group(Math.trunc(rounded))}.${Math.abs(rounded % 1)
          .toFixed(decimals)
          .slice(2)}`;
  return `${text}${unit}`;
}

/** 오르는 기사는 지금 값 위·도착 값 이하의 눈금, 내리는 기사는 지금 값 아래·도착 값 이상의 눈금 */
export function referenceLevel(plan: ReferenceSlotPlan): number {
  const target = plan.current * Math.exp(plan.move);
  const up = plan.move > 0;
  for (const step of LEVEL_STEPS[plan.code]) {
    const level = up ? Math.floor(target / step) * step : Math.ceil(target / step) * step;
    if (up ? level > plan.current : level < plan.current) return level;
  }
  return target;
}

function sampleReferenceSlot(spec: SlotSpec, plan: ReferenceSlotPlan): string | null {
  if (spec.kind === "percent") {
    const pct = Math.max(0.1, Math.abs(Math.exp(plan.move) - 1) * 100);
    return `${pct.toFixed(spec.decimals ?? 1)}%`;
  }
  if (spec.kind === "level") {
    const level = referenceLevel(plan);
    // 눈금이 정수면 정수로, 0.5·0.1 눈금이면 소수 한 자리로 쓴다.
    const decimals = Number.isInteger(Number(level.toFixed(6))) ? 0 : 1;
    return formatLevel(level, decimals, spec.unit);
  }
  return null;
}

/** A recently-used vocab entry is suppressed this hard, never to zero. */
const VOCAB_RECENCY_WEIGHT = 0.15;

function samplePick(vocab: VocabKey, ctx: SlotContext): string {
  // A company's own sites beat the generic list: "거제 공장 화재" reads right
  // where the fallback would produce "제1공장 공장 화재".
  const options =
    vocab === "plant" && ctx.profile?.plants.length
      ? ctx.profile.plants
      : vocabList(vocab, ctx.profile?.sector ?? null);
  if (options.length === 0) return "";

  const recent = new Set(ctx.memory.recentVocabPicks(vocab));
  const chosen =
    weightedPick(
      ctx.random,
      options.map((value) => ({ value, weight: recent.has(value) ? VOCAB_RECENCY_WEIGHT : 1 })),
    ) ?? options[0];
  ctx.memory.noteVocabPick(vocab, chosen);
  return chosen;
}

function sampleSlot(spec: SlotSpec, ctx: SlotContext): string {
  switch (spec.kind) {
    case "money": {
      const capEok = ctx.profile?.capEok ?? 10_000;
      const eok = Math.max(spec.minEok ?? 5, capEok * uniform(ctx.random, spec.capFraction));
      return formatEok(eok);
    }
    case "macroMoney":
      return formatEok(uniform(ctx.random, spec.eok));
    case "percent":
      return `${uniform(ctx.random, spec.range).toFixed(spec.decimals ?? 1)}%`;
    case "targetPrice": {
      const base = ctx.price ?? ctx.symbol?.initialPrice ?? 0;
      const target = snapToTick(
        roundNicePrice(base * uniform(ctx.random, spec.ratio)),
        ctx.symbol?.tickSize ?? 1,
      );
      return `${group(target)}원`;
    }
    case "level":
      return formatLevel(uniform(ctx.random, spec.range), spec.decimals ?? 0, spec.unit);
    case "multiple":
      return uniform(ctx.random, spec.range).toFixed(spec.decimals ?? 0);
    case "count":
      return `${group(randomInt(ctx.random, Math.round(spec.range.min), Math.round(spec.range.max)))}${spec.unit}`;
    case "duration":
      return `${randomInt(ctx.random, Math.round(spec.range.min), Math.round(spec.range.max))}${spec.unit}`;
    case "quarter":
      return quarterLabel(ctx.nowMs, spec.offsetQuarters ?? -1);
    case "pick":
      return samplePick(spec.vocab, ctx);
  }
}

/** Keys every SYMBOL-scope template can use without declaring them. */
export function autoBoundSlots(ctx: SlotContext): Record<string, string> {
  if (!ctx.symbol) return {};
  const price = ctx.price ?? ctx.symbol.initialPrice;
  return {
    name: ctx.symbol.name,
    symbol: ctx.symbol.symbol,
    price: `${group(Math.round(price))}원`,
  };
}

/**
 * Slots that identify *which story this is* and so carry over to a sequel.
 *
 * Deliberately excludes measurements. A parent's `pct` might be a dilution
 * ratio while its sequel's `pct` is a discount to the market price — copying
 * the number across would print a confidently wrong figure.
 */
const INHERITABLE_SLOTS = new Set(["money", "country", "counterparty", "product", "title", "plant"]);

export function bindSlots(template: NewsTemplate, ctx: SlotContext): Record<string, string> {
  const values: Record<string, string> = autoBoundSlots(ctx);
  const deferred: [string, SlotSpec][] = [];
  for (const [key, spec] of Object.entries(template.slots ?? {})) {
    // reference 슬롯은 {commodity} 같은 다른 슬롯이 정해진 뒤에 채운다.
    if ((spec.kind === "percent" || spec.kind === "level") && spec.reference) {
      deferred.push([key, spec]);
      continue;
    }
    // A sequel keeps the parent's identifying figures, so "3,200억 수주"
    // becomes "3,200억 본계약" rather than an unrelated new number.
    const inherited = INHERITABLE_SLOTS.has(key) ? ctx.inherited?.[key] : undefined;
    values[key] = inherited ?? sampleSlot(spec, ctx);
  }
  if (deferred.length > 0) {
    const plan = ctx.referencePlan?.(values) ?? null;
    for (const [key, spec] of deferred) values[key] = (plan && sampleReferenceSlot(spec, plan)) ?? sampleSlot(spec, ctx);
  }
  return values;
}

const PLACEHOLDER = /\{([a-zA-Z0-9_가-힣]+)\}/g;

/**
 * Renders left to right so a particle placeholder can agree with the text just
 * emitted before it. Throws on an unresolved key, which the catalog test turns
 * into a build-time failure rather than a runtime one.
 */
export function renderTemplate(pattern: string, values: Readonly<Record<string, string>>): string {
  let output = "";
  let cursor = 0;
  PLACEHOLDER.lastIndex = 0;

  for (const match of pattern.matchAll(PLACEHOLDER)) {
    const key = match[1];
    output += pattern.slice(cursor, match.index);
    cursor = match.index + match[0].length;

    if (isParticleKey(key)) {
      output += resolveParticle(key, output);
      continue;
    }
    const value = values[key];
    if (value === undefined) throw new Error(`Unresolved news slot: {${key}}`);
    output += value;
  }
  return output + pattern.slice(cursor);
}

/** Slot keys a template must declare — particle markers resolve themselves. */
export function placeholderKeys(pattern: string): string[] {
  return [...pattern.matchAll(PLACEHOLDER)]
    .map((match) => match[1])
    .filter((key) => !isParticleKey(key));
}
