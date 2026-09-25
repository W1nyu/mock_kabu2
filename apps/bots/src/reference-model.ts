import {
  REFERENCE_ASSETS,
  toReferenceUnits,
  type ReferenceAssetDef,
  type ReferenceCode,
  type ReferenceMacroChannel,
} from "@mock-kabu/shared";
import type { RandomSource } from "./market-model";

const SECONDS_PER_DAY = 86_400;
/** 평균 회귀 반감기 — 며칠에 걸쳐 기준값으로 천천히 끌려온다(무한히 떠내려가지 않게). */
const MEAN_REVERSION_HALF_LIFE_S = 4 * SECONDS_PER_DAY;
/** 뉴스 충격은 한 번에 튀지 않고 이 시간 상수로 몇 분에 걸쳐 가격에 스며든다. */
const IMPULSE_TIME_CONSTANT_S = 240;
/** 강도 1인 뉴스가 민감도 1인 자산을 움직이는 크기 = 하루 변동성 × 이 값 */
const IMPULSE_DAILY_VOL_MULTIPLE = 1.2;
/** 그 품목을 직접 언급한 기사는 채널 민감도와 별개로 이만큼 더 반영한다. */
const DIRECT_MENTION_WEIGHT = 1;

/** 뉴스 엔진이 넘기는 시장 전체 기사의 요약 — 봇 뉴스 타입에 의존하지 않게 필요한 것만 받는다. */
export interface ReferenceNewsSignal {
  channel: ReferenceMacroChannel | string | null | undefined;
  /** +1 오름, -1 내림 */
  direction: 1 | -1 | null | undefined;
  /** 0.2~1 */
  strength: number;
  /** 기사 슬롯의 {commodity} 값 (예: "구리") */
  commodity?: string | null;
}

interface AssetState {
  def: ReferenceAssetDef;
  logPrice: number;
  logAnchor: number;
  /** 아직 가격에 반영되지 않은 뉴스 충격(로그 수익률) */
  pendingImpulse: number;
}

function gaussian(random: RandomSource): number {
  // Box–Muller. 0을 피해 log(0)을 막는다.
  const u = Math.max(random.next(), 1e-12);
  const v = random.next();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * 원/달러·원자재 가상 지수. 기하 브라운 운동에 약한 평균 회귀를 더하고, 시장 전체 뉴스의
 * 채널 방향만큼 충격을 준다. `tick(초)`는 주입된 난수만 쓰므로 테스트에서 재현된다.
 */
export class ReferencePriceModel {
  private readonly states = new Map<ReferenceCode, AssetState>();

  constructor(
    private readonly random: RandomSource = { next: () => Math.random() },
    initial: Partial<Record<ReferenceCode, number>> = {},
    assets: readonly ReferenceAssetDef[] = REFERENCE_ASSETS,
  ) {
    for (const def of assets) {
      const start = initial[def.code];
      const value = start && Number.isFinite(start) && start > 0 ? start : def.anchor;
      this.states.set(def.code, {
        def,
        logPrice: Math.log(value),
        logAnchor: Math.log(def.anchor),
        pendingImpulse: 0,
      });
    }
  }

  /** 실제값 */
  value(code: ReferenceCode): number {
    const state = this.states.get(code);
    return state ? Math.exp(state.logPrice) : NaN;
  }

  /** API로 보낼 저장 정수 */
  snapshotUnits(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [code, state] of this.states) out[code] = toReferenceUnits(Math.exp(state.logPrice), state.def);
    return out;
  }

  tick(dtSeconds: number): void {
    if (!(dtSeconds > 0)) return;
    const kappa = Math.LN2 / MEAN_REVERSION_HALF_LIFE_S;
    const impulseShare = 1 - Math.exp(-dtSeconds / IMPULSE_TIME_CONSTANT_S);
    for (const state of this.states.values()) {
      const sigma = state.def.dailyVol / Math.sqrt(SECONDS_PER_DAY);
      const reversion = -kappa * (state.logPrice - state.logAnchor) * dtSeconds;
      const noise = sigma * Math.sqrt(dtSeconds) * gaussian(this.random);
      const impulse = state.pendingImpulse * impulseShare;
      state.pendingImpulse -= impulse;
      state.logPrice += reversion + noise + impulse;
    }
  }

  /**
   * 시장 전체 기사 하나를 반영한다. 채널 민감도 × 방향 × 강도, 그리고 기사가 품목을 직접 언급했으면
   * 그 품목에 한 번 더. 충격은 바로 반영되지 않고 몇 분에 걸쳐 스며든다.
   */
  applyNews(signal: ReferenceNewsSignal): void {
    if (!signal.direction || !(signal.strength > 0)) return;
    for (const state of this.states.values()) {
      const channelWeight = signal.channel ? (state.def.macro[signal.channel as ReferenceMacroChannel] ?? 0) : 0;
      const mentioned = signal.commodity && state.def.commodityWords.includes(signal.commodity) ? DIRECT_MENTION_WEIGHT : 0;
      const weight = channelWeight + mentioned;
      if (weight === 0) continue;
      state.pendingImpulse +=
        signal.direction * weight * signal.strength * state.def.dailyVol * IMPULSE_DAILY_VOL_MULTIPLE;
    }
  }
}
