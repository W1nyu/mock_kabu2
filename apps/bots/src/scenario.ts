/**
 * Admin market scenarios: for a window of time, lean selected symbols up or down.
 *
 * A scenario never moves a price directly. It only tilts probabilities that
 * already exist — which way a headline breaks, how often a symbol makes news,
 * how hard the story lands, and which side ordinary flow bots lean to. The
 * resulting tape is the same kind a run of genuine bad (or good) news
 * produces, so it cannot be told apart from ordinary market noise.
 */
export type ScenarioDirection = "UP" | "DOWN";

export interface PressureScenario {
  readonly id: string;
  readonly symbols: readonly string[];
  readonly direction: ScenarioDirection;
  /** 1 weak · 2 medium · 3 strong */
  readonly intensity: number;
  readonly startsAtMs: number;
  readonly endsAtMs: number;
}

/** Signed pressure is scaled to this per intensity level (index = level). */
const INTENSITY_MAGNITUDE = [0, 0.4, 0.7, 1] as const;
/** Pressure fades in and out instead of switching at the exact minute. */
const MAX_RAMP_MS = 10 * 60_000;

/** Signed pressure in [-1, 1] from a set of scenarios; 0 when none applies. */
export function scenarioPressure(
  scenarios: readonly PressureScenario[],
  symbol: string,
  nowMs: number,
): number {
  let total = 0;
  for (const scenario of scenarios) {
    if (!scenario.symbols.includes(symbol)) continue;
    if (nowMs <= scenario.startsAtMs || nowMs >= scenario.endsAtMs) continue;
    const level = INTENSITY_MAGNITUDE[scenario.intensity] ?? 0;
    const rampMs = Math.min(MAX_RAMP_MS, (scenario.endsAtMs - scenario.startsAtMs) / 4);
    const ramp = Math.min(1, (nowMs - scenario.startsAtMs) / rampMs, (scenario.endsAtMs - nowMs) / rampMs);
    total += (scenario.direction === "UP" ? 1 : -1) * level * ramp;
  }
  return Math.max(-1, Math.min(1, total));
}

/** The bot process's current copy of the scenarios, refreshed by polling. */
export class ScenarioBook {
  private scenarios: readonly PressureScenario[] = [];

  replace(scenarios: readonly PressureScenario[]): void {
    this.scenarios = scenarios;
  }

  pressure(symbol: string, nowMs: number = Date.now()): number {
    return scenarioPressure(this.scenarios, symbol, nowMs);
  }

  ids(): string {
    return this.scenarios.map((scenario) => scenario.id).sort().join(",");
  }
}

export interface ScenarioSource {
  activeScenarios(): Promise<PressureScenario[]>;
}

const POLL_INTERVAL_MS = 30_000;

/**
 * Keep `book` in sync with the API. A failed poll keeps the last known list:
 * scenarios already carry their own end time, so a stale copy still stops on
 * schedule.
 */
export function startScenarioPolling(source: ScenarioSource, book: ScenarioBook): { stop(): void } {
  const poll = async () => {
    try {
      const before = book.ids();
      book.replace(await source.activeScenarios());
      const after = book.ids();
      if (before !== after) console.log(`[scenario] active/upcoming: ${after || "none"}`);
    } catch (error) {
      console.error("[scenario] poll failed:", error instanceof Error ? error.message : error);
    }
  };
  void poll();
  const timer = setInterval(() => void poll(), POLL_INTERVAL_MS);
  timer.unref?.();
  return {
    stop() {
      clearInterval(timer);
    },
  };
}
