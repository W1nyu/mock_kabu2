/**
 * 자동 장세 사이클 — 상승장·하락장·횡보장과 금리·환율·유가·원자재의 상승기/하락기/안정기.
 *
 * 관리자 시나리오와 같은 원칙으로 가격을 직접 움직이지 않는다. 국면은 이미 있는 확률만
 * 기울인다: 종목·업종 기사의 호재/악재 비율, 어떤 시장 기사가 나올지, 기사 강도, 기사 빈도,
 * 일반 주문 흐름의 매수/매도 쏠림. 그래서 상승장에서도 악재는 나오고(덜 나올 뿐) 하락장에도
 * 반등이 있다.
 *
 * 국면 일정은 (비밀 시드, 고정 기점)만으로 정해지는 결정적 수열이다. 봇이 재시작해도 같은
 * 국면에서 이어 가고, 저장소가 공개돼 있어도 시드를 모르면 다음 국면을 미리 알 수 없다.
 */
import { createHash } from "node:crypto";
import {
  MACRO_CYCLE_DRIVERS,
  type MacroCycleDriver,
  type MacroCyclePhase,
  type MarketCyclePhase,
  type MarketCycleReport,
} from "@mock-kabu/shared";
import { positiveNewsProbability } from "./market-model";
import { companyProfile } from "./news/company-profiles";
import type { MacroChannel, Range } from "./news/types";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** 모든 일정의 기점. 이 값이나 시드를 바꾸면 국면 일정 전체가 새로 섞인다. */
export const MARKET_CYCLE_EPOCH_MS = Date.UTC(2026, 9, 1);

interface PhaseSpec {
  /** 한 번 이어지는 기간 */
  readonly hours: Range;
  /** 국면이 자리 잡는 기울기 크기 */
  readonly lean: Range;
  /** +1 상승 쪽, −1 하락 쪽, 0은 어느 쪽이든 아주 조금(박스권은 한쪽으로 살짝 기운 채 오르내린다) */
  readonly sign: 1 | -1 | 0;
  /** 기울기 주위의 느린 출렁임 — 상승장 속 조정, 하락장 속 반등, 박스권의 오르내림 */
  readonly swing: Range;
  readonly swingHours: Range;
}

interface TrackSpec<P extends string> {
  readonly phases: Readonly<Record<P, PhaseSpec>>;
  /** 한 국면이 끝난 뒤 다음 국면의 확률 */
  readonly next: Readonly<Record<P, Readonly<Partial<Record<P, number>>>>>;
  /** 맨 처음 국면의 확률 */
  readonly first: Readonly<Partial<Record<P, number>>>;
  /** 새 국면은 이전 기울기에서 이만큼에 걸쳐 넘어온다(국면 길이의 1/3 이하) */
  readonly easeMs: number;
}

/**
 * 상승장은 길고 완만하게, 하락장은 짧고 가파르게 — 실제 증시에서 강세장이 약세장보다 오래 가고
 * 약세장은 더 빨리 떨어지는 비대칭을 따랐다(평균 약 22시간 대 15시간, 횡보장 12시간).
 * 하락장은 기사 강도·빈도도 커진다(PHASE_VOLATILITY·PHASE_NEWS_ACTIVITY).
 */
const MARKET_TRACK: TrackSpec<MarketCyclePhase> = {
  phases: {
    BULL: {
      hours: { min: 12, max: 32 },
      lean: { min: 0.25, max: 0.5 },
      sign: 1,
      swing: { min: 0.05, max: 0.12 },
      swingHours: { min: 3, max: 8 },
    },
    BEAR: {
      hours: { min: 8, max: 22 },
      lean: { min: 0.3, max: 0.6 },
      sign: -1,
      swing: { min: 0.06, max: 0.15 },
      swingHours: { min: 2, max: 6 },
    },
    SIDEWAYS: {
      hours: { min: 6, max: 18 },
      lean: { min: 0, max: 0.05 },
      sign: 0,
      swing: { min: 0.1, max: 0.16 },
      swingHours: { min: 2, max: 5 },
    },
  },
  next: {
    BULL: { SIDEWAYS: 0.55, BEAR: 0.45 },
    BEAR: { SIDEWAYS: 0.55, BULL: 0.45 },
    SIDEWAYS: { BULL: 0.55, BEAR: 0.45 },
  },
  first: { BULL: 0.35, BEAR: 0.35, SIDEWAYS: 0.3 },
  easeMs: 90 * MINUTE,
};

/** 금리는 한 방향으로 오래 간다: 인상기 → 동결기 → 인하기(가끔 동결 없이 바로 방향 전환). */
const RATE_TRACK: TrackSpec<MacroCyclePhase> = {
  phases: {
    RISING: {
      hours: { min: 30, max: 72 },
      lean: { min: 0.5, max: 0.85 },
      sign: 1,
      swing: { min: 0.05, max: 0.12 },
      swingHours: { min: 8, max: 16 },
    },
    FALLING: {
      hours: { min: 30, max: 72 },
      lean: { min: 0.5, max: 0.85 },
      sign: -1,
      swing: { min: 0.05, max: 0.12 },
      swingHours: { min: 8, max: 16 },
    },
    STEADY: {
      hours: { min: 16, max: 40 },
      lean: { min: 0, max: 0.1 },
      sign: 0,
      swing: { min: 0.05, max: 0.1 },
      swingHours: { min: 8, max: 16 },
    },
  },
  next: {
    RISING: { STEADY: 0.75, FALLING: 0.25 },
    FALLING: { STEADY: 0.75, RISING: 0.25 },
    STEADY: { RISING: 0.5, FALLING: 0.5 },
  },
  first: { RISING: 0.35, FALLING: 0.35, STEADY: 0.3 },
  easeMs: 3 * HOUR,
};

/** 환율·유가·원자재는 금리보다 짧게 돈다. */
const PRICE_DRIVER_TRACK: TrackSpec<MacroCyclePhase> = {
  phases: {
    RISING: {
      hours: { min: 16, max: 40 },
      lean: { min: 0.4, max: 0.75 },
      sign: 1,
      swing: { min: 0.05, max: 0.12 },
      swingHours: { min: 5, max: 12 },
    },
    FALLING: {
      hours: { min: 16, max: 40 },
      lean: { min: 0.4, max: 0.75 },
      sign: -1,
      swing: { min: 0.05, max: 0.12 },
      swingHours: { min: 5, max: 12 },
    },
    STEADY: {
      hours: { min: 8, max: 24 },
      lean: { min: 0, max: 0.1 },
      sign: 0,
      swing: { min: 0.05, max: 0.1 },
      swingHours: { min: 5, max: 12 },
    },
  },
  next: {
    RISING: { STEADY: 0.5, FALLING: 0.5 },
    FALLING: { STEADY: 0.5, RISING: 0.5 },
    STEADY: { RISING: 0.5, FALLING: 0.5 },
  },
  first: { RISING: 0.35, FALLING: 0.35, STEADY: 0.3 },
  easeMs: 2 * HOUR,
};

const DRIVER_TRACKS: Readonly<Record<MacroCycleDriver, TrackSpec<MacroCyclePhase>>> = {
  RATE: RATE_TRACK,
  FX: PRICE_DRIVER_TRACK,
  OIL: PRICE_DRIVER_TRACK,
  COMMODITY: PRICE_DRIVER_TRACK,
};

/**
 * 금리 → 장세. 다음 장세를 고를 때 금리 기울기만큼 하락장 쪽 확률을 e^(k·r)배, 상승장 쪽을
 * e^(−k·r)배 한다. 인상기(r≈0.7)면 상승장 다음에 하락장이 올 확률이 45% → 약 55%.
 */
const RATE_TO_MARKET = 0.6;

/** 하락장은 기사 한 건이 더 크게 흔들고, 박스권은 덜 흔든다. */
const PHASE_VOLATILITY: Readonly<Record<MarketCyclePhase, number>> = { BULL: 0.95, BEAR: 1.12, SIDEWAYS: 0.88 };
/** 하락장엔 기사가 잦고(공포), 박스권엔 뜸하다. */
const PHASE_NEWS_ACTIVITY: Readonly<Record<MarketCyclePhase, number>> = { BULL: 1, BEAR: 1.2, SIDEWAYS: 0.85 };

/** 장기 적정 지수: 2026-09-22 00:00 KST 1,000에서 하루 0.1%씩 완만히 오른다. */
const FAIR_INDEX_BASE = 1_000;
const FAIR_INDEX_BASE_MS = Date.UTC(2026, 8, 21, 15);
const FAIR_INDEX_DAILY_GROWTH = 0.001;
/** 지수가 적정 수준에서 로그로 10% 벗어날 때마다 반대 방향 기울기 0.1, 최대 0.3 */
const VALUATION_PULL_PER_LOG = 1;
const MAX_VALUATION_PULL = 0.3;

interface Segment<P extends string> {
  readonly phase: P;
  /** 직전 국면(첫 국면이면 자기 자신) — 넘어오는 동안 강도·빈도를 섞는다 */
  readonly previous: P;
  readonly startMs: number;
  readonly endMs: number;
  readonly base: number;
  readonly swing: number;
  readonly swingPeriodMs: number;
  readonly swingOffset: number;
  readonly easeMs: number;
  /** 직전 국면이 끝날 때의 기울기 — 이 국면은 여기서부터 넘어온다 */
  readonly enteredFrom: number;
}

/** 시드 하나로 만드는 32비트 난수열(mulberry32) */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function seedFor(secret: string, track: string): number {
  return createHash("sha256").update(`market-cycle:${track}:${secret}`).digest().readUInt32BE(0);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function smoothstep(progress: number): number {
  const x = clamp(progress, 0, 1);
  return x * x * (3 - 2 * x);
}

function pickPhase<P extends string>(odds: Readonly<Partial<Record<P, number>>>, roll: number): P {
  const entries = (Object.entries(odds) as [P, number][]).filter(([, weight]) => weight > 0);
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  let cursor = roll * total;
  for (const [phase, weight] of entries) {
    cursor -= weight;
    if (cursor < 0) return phase;
  }
  return entries[entries.length - 1][0];
}

/** 이 국면이 자리 잡은 기울기(넘어오는 구간 제외) */
function settledLean(segment: Segment<string>, nowMs: number): number {
  const angle = (2 * Math.PI * (nowMs - segment.startMs)) / segment.swingPeriodMs + segment.swingOffset;
  return clamp(segment.base + segment.swing * Math.sin(angle), -1, 1);
}

function easeProgress(segment: Segment<string>, nowMs: number): number {
  return segment.easeMs > 0 ? smoothstep((nowMs - segment.startMs) / segment.easeMs) : 1;
}

function leanOf(segment: Segment<string>, nowMs: number): number {
  const progress = easeProgress(segment, nowMs);
  return segment.enteredFrom + (settledLean(segment, nowMs) - segment.enteredFrom) * progress;
}

/**
 * 한 사이클의 국면 수열. 기점부터 차례로 국면을 뽑아 두고, 시간이 지나면 이어서 뽑는다.
 * 어떤 순서로 조회해도 같은 시각엔 같은 국면이다(수열은 자기 난수만 쓴다).
 */
class CycleTrack<P extends string> {
  private readonly segments: Segment<P>[] = [];

  constructor(
    private readonly spec: TrackSpec<P>,
    private readonly random: () => number,
    private readonly epochMs: number,
    /** 다음 국면 확률을 그때의 다른 사이클로 조정한다(금리 → 장세) */
    private readonly adjustNext?: (odds: Readonly<Partial<Record<P, number>>>, atMs: number) => Partial<Record<P, number>>,
  ) {}

  segmentAt(nowMs: number): Segment<P> {
    if (this.segments.length === 0) {
      const first = pickPhase(this.spec.first, this.random());
      this.segments.push(this.makeSegment(first, first, this.epochMs, 0));
    }
    let last = this.segments[this.segments.length - 1];
    while (last.endMs <= nowMs) {
      const odds = this.adjustNext ? this.adjustNext(this.spec.next[last.phase], last.endMs) : this.spec.next[last.phase];
      const phase = pickPhase(odds, this.random());
      last = this.makeSegment(phase, last.phase, last.endMs, settledLean(last, last.endMs));
      this.segments.push(last);
    }
    // 기점 이전이면 첫 국면. 아니면 이분 탐색.
    let low = 0;
    let high = this.segments.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (this.segments[middle].startMs <= nowMs) low = middle;
      else high = middle - 1;
    }
    return this.segments[low];
  }

  leanAt(nowMs: number): number {
    return leanOf(this.segmentAt(nowMs), nowMs);
  }

  private makeSegment(phase: P, previous: P, startMs: number, enteredFrom: number): Segment<P> {
    const spec = this.spec.phases[phase];
    const draw = (range: Range) => range.min + (range.max - range.min) * this.random();
    const durationMs = Math.round(draw(spec.hours) * HOUR);
    const size = draw(spec.lean);
    const sign = spec.sign !== 0 ? spec.sign : this.random() < 0.5 ? -1 : 1;
    const swing = draw(spec.swing);
    const swingPeriodMs = draw(spec.swingHours) * HOUR;
    const swingOffset = this.random() * 2 * Math.PI;
    return {
      phase,
      previous,
      startMs,
      endMs: startMs + durationMs,
      base: sign * size,
      swing,
      swingPeriodMs,
      swingOffset,
      easeMs: Math.min(this.spec.easeMs, durationMs / 3),
      enteredFrom,
    };
  }
}

export interface CyclePhaseState<P extends string> {
  readonly phase: P;
  readonly sinceMs: number;
  /** −1 ~ +1, 넘어오는 구간·출렁임 포함 */
  readonly lean: number;
}

export interface CycleSnapshot {
  readonly market: CyclePhaseState<MarketCyclePhase> & {
    /** 기사 강도 배율 */
    readonly volatility: number;
    /** 기사 빈도 배율 */
    readonly newsActivity: number;
  };
  readonly drivers: Readonly<Record<MacroCycleDriver, CyclePhaseState<MacroCyclePhase>>>;
}

export class MarketCycle {
  private readonly market: CycleTrack<MarketCyclePhase>;
  private readonly drivers: Record<MacroCycleDriver, CycleTrack<MacroCyclePhase>>;

  constructor(secret: string, epochMs: number = MARKET_CYCLE_EPOCH_MS) {
    this.drivers = Object.fromEntries(
      MACRO_CYCLE_DRIVERS.map((driver) => [
        driver,
        new CycleTrack(DRIVER_TRACKS[driver], seededRandom(seedFor(secret, driver)), epochMs),
      ]),
    ) as Record<MacroCycleDriver, CycleTrack<MacroCyclePhase>>;
    const rate = this.drivers.RATE;
    this.market = new CycleTrack(MARKET_TRACK, seededRandom(seedFor(secret, "market")), epochMs, (odds, atMs) => {
      const tilt = RATE_TO_MARKET * rate.leanAt(atMs);
      return {
        ...odds,
        ...(odds.BEAR !== undefined ? { BEAR: odds.BEAR * Math.exp(tilt) } : {}),
        ...(odds.BULL !== undefined ? { BULL: odds.BULL * Math.exp(-tilt) } : {}),
      };
    });
  }

  snapshot(nowMs: number): CycleSnapshot {
    const segment = this.market.segmentAt(nowMs);
    const progress = easeProgress(segment, nowMs);
    const blend = (table: Readonly<Record<MarketCyclePhase, number>>) =>
      table[segment.previous] + (table[segment.phase] - table[segment.previous]) * progress;
    const drivers = Object.fromEntries(
      MACRO_CYCLE_DRIVERS.map((driver) => {
        const track = this.drivers[driver];
        const driverSegment = track.segmentAt(nowMs);
        return [driver, { phase: driverSegment.phase, sinceMs: driverSegment.startMs, lean: leanOf(driverSegment, nowMs) }];
      }),
    ) as Record<MacroCycleDriver, CyclePhaseState<MacroCyclePhase>>;
    return {
      market: {
        phase: segment.phase,
        sinceMs: segment.startMs,
        lean: leanOf(segment, nowMs),
        volatility: blend(PHASE_VOLATILITY),
        newsActivity: blend(PHASE_NEWS_ACTIVITY),
      },
      drivers,
    };
  }
}

/** 장기 적정 지수 */
export function fairIndex(nowMs: number): number {
  const days = (nowMs - FAIR_INDEX_BASE_MS) / (24 * HOUR);
  return FAIR_INDEX_BASE * Math.exp(FAIR_INDEX_DAILY_GROWTH * days);
}

/**
 * 밸류에이션 — 지수가 적정 수준보다 많이 올라 있으면 악재 쪽으로, 많이 빠져 있으면 호재 쪽으로
 * 약하게 당긴다. 장세 사이클보다 약해서 상승장이 고점에서 멈추게 하진 않지만, 원인 모를 한쪽
 * 쏠림(예: 사용자 순매수)이 몇 주씩 쌓이는 건 막는다.
 */
export function valuationPull(index: number | null, nowMs: number): number {
  if (index == null || !(index > 0)) return 0;
  return clamp(-VALUATION_PULL_PER_LOG * Math.log(index / fairIndex(nowMs)), -MAX_VALUATION_PULL, MAX_VALUATION_PULL);
}

/** 뉴스·주문 흐름이 읽는 지금 장세 */
export interface MarketMood {
  readonly phase: MarketCyclePhase;
  /** 장세 사이클 + 밸류에이션, −1 ~ +1(양수면 상승 쪽) */
  readonly marketLean: number;
  /** 거시 변수별 기울기(+면 오르는 쪽: 금리 인상·원화 약세·유가 상승). GLOBAL은 장세 자체라 0 */
  readonly channelLean: Readonly<Record<MacroChannel, number>>;
  /** 기사 강도 배율 */
  readonly volatility: number;
  /** 기사 빈도 배율 */
  readonly newsActivity: number;
}

/**
 * 장세를 얼마나 타는지 — 시장 민감도(GLOBAL 베타)가 큰 종목일수록 크게.
 * 경기 방어주(식품·통신·리츠)는 상승장·하락장을 덜 탄다.
 */
export function marketSensitivity(symbol: string): number {
  const beta = companyProfile(symbol)?.macroBeta.GLOBAL ?? 1;
  return clamp(0.55 + 0.45 * beta, 0.6, 1.2);
}

export function symbolLean(mood: MarketMood, symbol: string): number {
  return clamp(mood.marketLean * marketSensitivity(symbol), -1, 1);
}

/** 같은 순간에 수없이 묻는 주문 흐름을 위해 잠깐 캐시한다 */
const MOOD_CACHE_MS = 5_000;

/** 장세 사이클 + 지금 지수 → 뉴스·주문 흐름이 읽는 MarketMood, 관리자 보고 */
export class MarketMoodSource {
  private index: number | null = null;
  private cached: { atMs: number; mood: MarketMood } | null = null;

  constructor(private readonly cycle: MarketCycle) {}

  observeIndex(index: number): void {
    if (!Number.isFinite(index) || index <= 0) return;
    this.index = index;
    this.cached = null;
  }

  at(nowMs: number): MarketMood {
    if (this.cached && Math.abs(nowMs - this.cached.atMs) < MOOD_CACHE_MS) return this.cached.mood;
    const snapshot = this.cycle.snapshot(nowMs);
    const mood: MarketMood = {
      phase: snapshot.market.phase,
      marketLean: clamp(snapshot.market.lean + valuationPull(this.index, nowMs), -1, 1),
      channelLean: {
        RATE: snapshot.drivers.RATE.lean,
        FX: snapshot.drivers.FX.lean,
        OIL: snapshot.drivers.OIL.lean,
        COMMODITY: snapshot.drivers.COMMODITY.lean,
        GLOBAL: 0,
      },
      volatility: snapshot.market.volatility,
      newsActivity: snapshot.market.newsActivity,
    };
    this.cached = { atMs: nowMs, mood };
    return mood;
  }

  report(nowMs: number): MarketCycleReport {
    const snapshot = this.cycle.snapshot(nowMs);
    const pull = valuationPull(this.index, nowMs);
    const lean = clamp(snapshot.market.lean + pull, -1, 1);
    const round = (value: number, digits = 3) => Number(value.toFixed(digits));
    return {
      reportedAtMs: nowMs,
      market: {
        phase: snapshot.market.phase,
        sinceMs: snapshot.market.sinceMs,
        cycleLean: round(snapshot.market.lean),
        lean: round(lean),
        positiveShare: round(positiveNewsProbability(lean)),
      },
      drivers: Object.fromEntries(
        MACRO_CYCLE_DRIVERS.map((driver) => {
          const state = snapshot.drivers[driver];
          return [driver, { phase: state.phase, sinceMs: state.sinceMs, lean: round(state.lean) }];
        }),
      ) as MarketCycleReport["drivers"],
      valuation: {
        index: this.index == null ? null : round(this.index, 2),
        fairIndex: round(fairIndex(nowMs), 2),
        pull: round(pull),
      },
    };
  }
}

/** 지수 구성 — `/market/index/meta` */
export interface IndexMeta {
  readonly divisor: number;
  readonly members: readonly { readonly symbol: string; readonly listedShares: number }[];
}

/** 시가총액 가중 지수 = Σ(가격 × 상장 주식 수) ÷ 제수. 가격을 모르는 종목이 있으면 null. */
export function marketIndexFrom(meta: IndexMeta, priceOf: (symbol: string) => number | null): number | null {
  if (!(meta.divisor > 0) || meta.members.length === 0) return null;
  let cap = 0;
  for (const member of meta.members) {
    const price = priceOf(member.symbol);
    if (price == null || !(price > 0)) return null;
    cap += price * member.listedShares;
  }
  return cap / meta.divisor;
}

export interface MarketCycleClient {
  indexMeta(): Promise<IndexMeta>;
  publishMarketCycle(report: MarketCycleReport): Promise<void>;
}

const REPORT_INTERVAL_MS = 60_000;
const META_REFRESH_MS = 10 * MINUTE;

function phaseLine(report: MarketCycleReport): string {
  const drivers = MACRO_CYCLE_DRIVERS.map((driver) => `${driver} ${report.drivers[driver].phase}`).join(" · ");
  return `market ${report.market.phase} · ${drivers}`;
}

/**
 * 1분마다 봇 기준가로 지수를 계산해 밸류에이션에 넣고, 관리자 화면용 보고를 API에 보낸다.
 * 국면이 바뀌면 로그를 남긴다. 실패해도 다음 주기에 다시 한다 — 장세 자체는 시계만으로 돈다.
 */
export function startMarketCycleLoop(
  client: MarketCycleClient,
  priceOf: (symbol: string) => number | null,
  mood: MarketMoodSource,
): { stop(): void } {
  let meta: IndexMeta | null = null;
  let metaAtMs = 0;
  let lastLine = "";
  let running = false;

  const run = async () => {
    if (running) return;
    running = true;
    try {
      const nowMs = Date.now();
      if (!meta || nowMs - metaAtMs >= META_REFRESH_MS) {
        try {
          meta = await client.indexMeta();
          metaAtMs = nowMs;
        } catch (error) {
          console.warn("[cycle] index meta failed:", error instanceof Error ? error.message : error);
        }
      }
      const index = meta ? marketIndexFrom(meta, priceOf) : null;
      if (index != null) mood.observeIndex(index);

      const report = mood.report(nowMs);
      const line = phaseLine(report);
      if (line !== lastLine) {
        console.log(
          `[cycle] ${line} (lean ${report.market.lean >= 0 ? "+" : ""}${report.market.lean}, good news ${Math.round(report.market.positiveShare * 100)}%, index ${report.valuation.index ?? "?"} / fair ${report.valuation.fairIndex})`,
        );
        lastLine = line;
      }
      await client.publishMarketCycle(report).catch((error) => {
        console.warn("[cycle] report failed:", error instanceof Error ? error.message : error);
      });
    } finally {
      running = false;
    }
  };

  void run();
  const timer = setInterval(() => void run(), REPORT_INTERVAL_MS);
  timer.unref?.();
  return {
    stop() {
      clearInterval(timer);
    },
  };
}
