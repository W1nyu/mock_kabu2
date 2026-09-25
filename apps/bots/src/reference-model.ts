import {
  REFERENCE_ASSETS,
  toReferenceUnits,
  type ReferenceAssetDef,
  type ReferenceCode,
} from "@mock-kabu/shared";
import type { RandomSource } from "./market-model";

const SECONDS_PER_DAY = 86_400;
/** 평균 회귀 반감기 — 며칠에 걸쳐 기준값으로 천천히 끌려온다(무한히 떠내려가지 않게). */
const MEAN_REVERSION_HALF_LIFE_S = 4 * SECONDS_PER_DAY;
/** 뉴스 충격은 한 번에 튀지 않고 이 시간 상수로 몇 분에 걸쳐 가격에 스며든다. */
const IMPULSE_TIME_CONSTANT_S = 240;
/** 뉴스 충격 중 기사가 나오는 순간 바로 반영하는 몫 — 기사 속 숫자와 화면 가격이 어긋나 보이지 않게. 나머지는 몇 분에 걸쳐 스며든다. */
const IMMEDIATE_SHARE = 0.5;

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
   * 뉴스 한 건의 충격(로그 수익률)을 반영한다. 절반은 즉시, 나머지는 시간 상수에 걸쳐.
   * 크기는 뉴스 생성기가 기사 속 숫자를 만들 때 쓴 값(`referenceNewsMove`)과 같다.
   */
  applyMove(code: ReferenceCode, logMove: number): void {
    const state = this.states.get(code);
    if (!state || !Number.isFinite(logMove) || logMove === 0) return;
    state.logPrice += logMove * IMMEDIATE_SHARE;
    state.pendingImpulse += logMove * (1 - IMMEDIATE_SHARE);
  }
}
