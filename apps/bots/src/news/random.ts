import type { RandomSource } from "../market-model";

/**
 * Deliberately duplicated from market-model rather than exported from it.
 * Widening that module's public surface for three one-line helpers costs more
 * than the twelve lines here, and the news engine is free to evolve its own
 * sampling without perturbing the price model's RNG contract.
 */

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Same bound as the price model: never returns exactly 1. */
export function unitRandom(random: RandomSource): number {
  return clamp(random.next(), 0, 0.999_999);
}

export function randomInt(random: RandomSource, min: number, max: number): number {
  return Math.floor(unitRandom(random) * (max - min + 1)) + min;
}

export interface Range {
  readonly min: number;
  readonly max: number;
}

export function uniform(random: RandomSource, range: Range): number {
  return range.min + (range.max - range.min) * unitRandom(random);
}

/**
 * Triangular draw over the range. Averaging two uniforms concentrates mass in
 * the middle, so an "average" story is common and an extreme reading of the
 * same story stays rare.
 */
export function triangular(random: RandomSource, range: Range): number {
  const centered = 0.5 * (unitRandom(random) + unitRandom(random));
  return range.min + (range.max - range.min) * centered;
}

export function pickOne<T>(random: RandomSource, items: readonly T[]): T {
  if (items.length === 0) throw new Error("pickOne on an empty list");
  return items[randomInt(random, 0, items.length - 1)];
}

export interface Weighted<T> {
  readonly value: T;
  readonly weight: number;
}

/**
 * Weighted pick. Non-finite and non-positive weights are treated as zero; when
 * every candidate has been zeroed out the choice falls back to uniform so a
 * caller's suppression rules can never deadlock the pool.
 */
export function weightedPick<T>(random: RandomSource, candidates: readonly Weighted<T>[]): T | null {
  if (candidates.length === 0) return null;

  let total = 0;
  for (const candidate of candidates) {
    if (Number.isFinite(candidate.weight) && candidate.weight > 0) total += candidate.weight;
  }
  if (total <= 0) return pickOne(random, candidates).value;

  let threshold = unitRandom(random) * total;
  for (const candidate of candidates) {
    const weight = Number.isFinite(candidate.weight) && candidate.weight > 0 ? candidate.weight : 0;
    threshold -= weight;
    if (threshold < 0) return candidate.value;
  }
  return candidates[candidates.length - 1].value;
}
