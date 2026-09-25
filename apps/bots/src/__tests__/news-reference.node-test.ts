import assert from "node:assert/strict";
import { test } from "node:test";
import { SYMBOLS, type ReferenceCode } from "@mock-kabu/shared";
import { MarketModel, type RandomSource } from "../market-model";
import { generateMacroNews, type GeneratorContext } from "../news/generator";
import { RecentNewsMemory } from "../news/memory";
import { referenceLevel } from "../news/slots";
import type { NewsItem } from "../news/types";

function seededRandom(seed: number): RandomSource {
  let state = seed >>> 0;
  return {
    next() {
      state = (state * 1_664_525 + 1_013_904_223) >>> 0;
      return state / 0x1_0000_0000;
    },
  };
}

const NOW: Record<ReferenceCode, number> = { USDKRW: 1_403.2, OIL: 100.4, GAS: 98.7, COPPER: 101.1, GOLD: 100.2, CORN: 99.6 };

function context(seed: number): GeneratorContext {
  const model = new MarketModel(SYMBOLS, { random: seededRandom(seed), eventSpawnChance: 0 });
  let sequence = 0;
  return {
    nowMs: 0,
    random: seededRandom(seed),
    symbols: SYMBOLS,
    sidewaysScores: new Map(SYMBOLS.map((s) => [s.symbol, model.sidewaysScore(s.symbol)])),
    prices: new Map(SYMBOLS.map((s) => [s.symbol, model.get(s.symbol)])),
    memory: new RecentNewsMemory(),
    nextSequence: () => ++sequence,
    referenceValue: (code) => NOW[code],
  };
}

function draw(templateId: string, seed = 11): NewsItem {
  const ctx = context(seed);
  for (let attempt = 0; attempt < 6_000; attempt++) {
    const item = generateMacroNews(ctx);
    if (item?.templateId === templateId) return item;
  }
  throw new Error(`never drew ${templateId}`);
}

const number = (text: string) => Number(text.replace(/[^0-9.]/g, ""));

test("the level in a headline sits between today's price and where the story takes it", () => {
  // 1,403.2원에서 +0.6% → 1,411.6원: 1,410원 "돌파"
  assert.equal(referenceLevel({ code: "USDKRW", current: 1_403.2, move: 0.006 }), 1_410);
  // 움직임이 작으면 더 잘게: 1,405.9원 → 1,405원
  assert.equal(referenceLevel({ code: "USDKRW", current: 1_403.2, move: 0.002 }), 1_405);
  // 내리는 기사: 1,394.8원 → 1,400원 "아래로"
  assert.equal(referenceLevel({ code: "USDKRW", current: 1_403.2, move: -0.006 }), 1_400);
  assert.equal(referenceLevel({ code: "OIL", current: 100.4, move: 0.02 }), 102);
});

test("an FX spike names a won/dollar level just above the live rate and moves the rate up by the same story", () => {
  const item = draw("macro.fx.spike");
  const level = number(item.slotValues.level);
  const move = item.referenceMoves?.find((m) => m.code === "USDKRW")?.move ?? 0;
  assert.ok(move > 0, "the rate goes up");
  assert.ok(level > NOW.USDKRW && level <= NOW.USDKRW * Math.exp(move) + 1e-9, `level ${level} vs ${NOW.USDKRW}→${NOW.USDKRW * Math.exp(move)}`);
});

test("an FX intervention names a level just below the live rate — not a random 1,300원", () => {
  const item = draw("macro.fx.intervene");
  const level = number(item.slotValues.level);
  assert.ok(level < NOW.USDKRW && level > 1_380, `level ${level}`);
  assert.ok((item.referenceMoves?.[0]?.move ?? 0) < 0);
});

test("an oil slump's percent is the actual oil move, and it nudges gas but never copper or FX", () => {
  const item = draw("macro.opec.raise");
  const oil = item.referenceMoves!.find((m) => m.code === "OIL")!.move;
  assert.ok(oil < 0);
  if (item.slotValues.pct) {
    assert.equal(item.slotValues.pct, `${(Math.abs(Math.exp(oil) - 1) * 100).toFixed(1)}%`);
  }
  const codes = item.referenceMoves!.map((m) => m.code).sort();
  assert.deepEqual(codes, ["GAS", "OIL"]);
});

test("a natural-gas story moves gas most, and freight news moves no futures underlying", () => {
  const gas = draw("macro.gas.spike");
  const moves = Object.fromEntries(gas.referenceMoves!.map((m) => [m.code, m.move]));
  assert.ok(moves.GAS > moves.OIL && moves.OIL > 0);
  assert.equal(draw("macro.freight.up").referenceMoves, undefined);
});

test("a metals story moves copper only when it is about copper-family metals", () => {
  for (let seed = 1; seed < 40; seed++) {
    const item = draw("macro.metal.spike", seed);
    const commodity = item.slotValues.commodity;
    const codes = (item.referenceMoves ?? []).map((m) => m.code);
    if (commodity === "구리") assert.deepEqual(codes, ["COPPER"]);
    if (commodity === "리튬") assert.deepEqual(codes, []);
    if (commodity === "천연가스") assert.ok(codes.includes("GAS") && !codes.includes("COPPER"));
  }
});

test("an operator can force a specific market story — unknown ids produce nothing", () => {
  const item = generateMacroNews(context(3), "macro.oil.spike");
  assert.equal(item?.templateId, "macro.oil.spike");
  assert.ok((item?.referenceMoves ?? []).some((m) => m.code === "OIL" && m.move > 0));
  assert.equal(generateMacroNews(context(3), "macro.nope"), null);
});
