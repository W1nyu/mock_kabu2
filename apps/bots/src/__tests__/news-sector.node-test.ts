import assert from "node:assert/strict";
import { test } from "node:test";
import { industryOf, SYMBOLS } from "@mock-kabu/shared";
import { MarketModel, type RandomSource } from "../market-model";
import { NEWS_TEMPLATES, SECTOR_POOL, templateById } from "../news/catalog";
import { companyProfile } from "../news/company-profiles";
import { generateSectorNews, type GeneratorContext } from "../news/generator";
import { RecentNewsMemory } from "../news/memory";
import { NewsScheduler } from "../news/scheduler";
import { RingBufferNewsSink } from "../news/sink";
import { placeholderKeys } from "../news/slots";

function seededRandom(seed: number): RandomSource {
  let state = seed >>> 0;
  return {
    next() {
      state = (state * 1_664_525 + 1_013_904_223) >>> 0;
      return state / 0x1_0000_0000;
    },
  };
}

function contextFor(random: RandomSource): GeneratorContext {
  const model = new MarketModel(SYMBOLS, { random, eventSpawnChance: 0 });
  let sequence = 0;
  return {
    nowMs: 0,
    random,
    symbols: SYMBOLS,
    sidewaysScores: new Map(SYMBOLS.map((s) => [s.symbol, model.sidewaysScore(s.symbol)])),
    prices: new Map(SYMBOLS.map((s) => [s.symbol, model.get(s.symbol)])),
    memory: new RecentNewsMemory(),
    nextSequence: () => ++sequence,
  };
}

const LISTED_SECTORS = new Set(SYMBOLS.map((s) => companyProfile(s.symbol)?.sector));

test("sector templates declare exposure, name no company, and only they carry exposure", () => {
  assert.ok(SECTOR_POOL.length >= 30, `sector pool is ${SECTOR_POOL.length}`);
  for (const template of NEWS_TEMPLATES) {
    if (template.scope !== "SECTOR") {
      assert.equal(template.sectorExposure, undefined, `${template.id}: exposure on a non-sector story`);
      continue;
    }
    const exposure = Object.entries(template.sectorExposure ?? {});
    assert.ok(exposure.length > 0, `${template.id}: SECTOR scope needs sectorExposure`);
    // 상장 폐지로 주 대상 업종에 종목이 없어진 기사는 템플릿으로 남되 뽑히지 않는다(SECTOR_POOL에서 빠진다).
    const listed = exposure.some(([sector, weight]) => (weight ?? 0) === 1 && LISTED_SECTORS.has(sector as never));
    assert.equal(SECTOR_POOL.includes(template), listed, `${template.id}: pool membership follows listed sectors`);
    for (const [, weight] of exposure) assert.ok(Math.abs(weight ?? 0) <= 1, `${template.id}: weight out of range`);
    for (const pattern of [...template.headlines, ...(template.body ?? [])]) {
      assert.ok(
        !placeholderKeys(pattern).some((key) => ["name", "symbol", "price"].includes(key)),
        `${template.id}: an industry story must not name a company`,
      );
    }
    assert.equal(template.macroChannel, undefined, `${template.id}: macroChannel on a sector story`);
  }
});

test("the sector pool is balanced so it adds no drift", () => {
  const positive = SECTOR_POOL.filter((t) => t.sentiment === "POSITIVE").length;
  assert.ok(
    Math.abs(positive - (SECTOR_POOL.length - positive)) <= 2,
    `sector pool is lopsided: ${positive} positive vs ${SECTOR_POOL.length - positive} negative`,
  );
});

test("every industry has at least one story aimed at it", () => {
  const covered = new Set(
    SECTOR_POOL.flatMap((t) =>
      Object.entries(t.sectorExposure ?? {})
        .filter(([, weight]) => weight === 1)
        .map(([sector]) => sector),
    ),
  );
  for (const symbol of SYMBOLS) {
    const sector = companyProfile(symbol.symbol)!.sector;
    assert.ok(covered.has(sector), `no industry story leads with ${sector} (${symbol.symbol})`);
  }
});

test("an industry story moves its industry, knocks on to neighbours, and flips negative weights", () => {
  const template = templateById("sec.lithium.drop")!;
  let item = null;
  for (let seed = 1; seed < 500 && item?.templateId !== template.id; seed++) {
    item = generateSectorNews(contextFor(seededRandom(seed)));
  }
  assert.equal(item?.templateId, "sec.lithium.drop");
  assert.equal(item!.scope, "SECTOR");
  assert.equal(item!.symbol, null);
  assert.equal(item!.industry, industryOf("NOVA")!.id);

  const bySymbol = new Map(item!.impact.map((impact) => [impact.symbol, impact]));
  assert.equal(bySymbol.get("NOVA")?.sentiment, "POSITIVE"); // battery: cheaper lithium
  assert.equal(bySymbol.get("NEKO")?.sentiment, "NEGATIVE"); // materials: weight -0.6
  assert.ok(!bySymbol.has("KABU"), "an unrelated industry is untouched");
  assert.ok(bySymbol.get("NOVA")!.strength > bySymbol.get("NEKO")!.strength * 0.9);
});

test("the scheduler publishes industry stories alongside company and macro news", () => {
  const random = seededRandom(7);
  const model = new MarketModel(SYMBOLS, { random, eventSpawnChance: 0 });
  const sink = new RingBufferNewsSink(500);
  const scheduler = new NewsScheduler(model, SYMBOLS, sink, { random });
  const scopes = new Map<string, number>();
  for (let now = 0; now < 4 * 3_600_000; now += 5_000) {
    const item = scheduler.tick(now);
    if (item) scopes.set(item.scope, (scopes.get(item.scope) ?? 0) + 1);
  }
  assert.ok((scopes.get("SECTOR") ?? 0) >= 6, `sector stories in 4h: ${scopes.get("SECTOR") ?? 0}`);
  assert.ok((scopes.get("SYMBOL") ?? 0) > (scopes.get("SECTOR") ?? 0), "company news stays the main stream");
});
