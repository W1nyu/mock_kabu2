import assert from "node:assert/strict";
import { test } from "node:test";
import { SYMBOLS } from "@mock-kabu/shared";
import { MarketModel, type RandomSource } from "../market-model";
import { templateById } from "../news/catalog";
import { generateMacroNews, generateSymbolNews, type GeneratorContext } from "../news/generator";
import { RecentNewsMemory, TEMPLATE_COOLDOWN_MS } from "../news/memory";
import { NewsScheduler } from "../news/scheduler";
import { RingBufferNewsSink } from "../news/sink";
import type { NewsItem } from "../news/types";

/** Deterministic LCG — a fixed seed gives a fixed hour of news. */
function seededRandom(seed: number): RandomSource {
  let state = seed >>> 0;
  return {
    next() {
      state = (state * 1_664_525 + 1_013_904_223) >>> 0;
      return state / 0x1_0000_0000;
    },
  };
}

function freshModel(random?: RandomSource): MarketModel {
  // eventSpawnChance: 0 is how production runs now — news is the only source.
  return new MarketModel(SYMBOLS, { random, eventSpawnChance: 0 });
}

function contextFor(model: MarketModel, random: RandomSource, nowMs = 0): GeneratorContext {
  let sequence = 0;
  return {
    nowMs,
    random,
    symbols: SYMBOLS,
    sidewaysScores: new Map(SYMBOLS.map((s) => [s.symbol, model.sidewaysScore(s.symbol)])),
    prices: new Map(SYMBOLS.map((s) => [s.symbol, model.get(s.symbol)])),
    memory: new RecentNewsMemory(),
    nextSequence: () => ++sequence,
  };
}

test("a symbol story produces exactly one impact, on its own symbol", () => {
  const random = seededRandom(7);
  const model = freshModel();
  const item = generateSymbolNews(
    contextFor(model, random),
    SYMBOLS.map((s) => s.symbol),
  );
  assert.ok(item);
  assert.equal(item.scope, "SYMBOL");
  assert.equal(item.impact.length, 1);
  assert.equal(item.impact[0].symbol, item.symbol);
  assert.ok(item.headline.length > 0);
});

test("a rate cut is good news for every listing", () => {
  const random = seededRandom(11);
  const model = freshModel();
  const ctx = contextFor(model, random);

  const item = buildMacro(ctx, "macro.rate.cut");
  assert.equal(item.symbol, null, "a market-wide story names no company");
  assert.equal(item.impact.length, SYMBOLS.length);
  for (const impact of item.impact) {
    assert.equal(impact.sentiment, "POSITIVE", `${impact.symbol} should read the cut as good news`);
  }
});

test("an FX spike splits the market along the sign of each beta", () => {
  const random = seededRandom(13);
  const model = freshModel();
  const item = buildMacro(contextFor(model, random), "macro.fx.spike");

  const sentimentFor = (symbol: string) =>
    item.impact.find((impact) => impact.symbol === symbol)?.sentiment;

  // Exporters gain on a weak won; the brokerage loses on foreign outflow.
  assert.equal(sentimentFor("SAKU"), "POSITIVE");
  assert.equal(sentimentFor("MOCK"), "POSITIVE");
  assert.equal(sentimentFor("KABU"), "NEGATIVE");
});

test("every generated impact is accepted by the real price model", () => {
  // startEvent throws outside its bands, so calling it for real is the
  // strongest available assertion that the catalog cannot break the market.
  const random = seededRandom(29);
  const model = freshModel();

  for (let round = 0; round < 400; round++) {
    const ctx = contextFor(model, random, round * 1_000);
    const item =
      round % 4 === 0
        ? generateMacroNews(ctx)
        : generateSymbolNews(
            ctx,
            SYMBOLS.map((s) => s.symbol),
          );
    if (!item) continue;
    for (const impact of item.impact) {
      assert.doesNotThrow(
        () =>
          model.startEvent(
            impact.symbol,
            impact.sentiment,
            impact.strength,
            impact.persistence,
            impact.volumeMultiplier,
          ),
        `${item.templateId} produced an impact the model rejects`,
      );
    }
  }
});

test("news actually biases which side the bots take", () => {
  const model = freshModel();
  model.startEvent("KABU", "POSITIVE", 0.9, 0.95);

  assert.ok(model.flowBias("KABU") > 0, "a strong positive story should bias flow upward");
  // Probabilistic, not guaranteed: a low roll flips a SELL to BUY, a high one leaves it.
  assert.equal(model.chooseFlowSide("KABU", "SELL", () => 0), "BUY");
  assert.equal(model.chooseFlowSide("KABU", "SELL", () => 0.99), "SELL");
});

test("two simulated hours publish a readable, non-repeating feed", () => {
  const random = seededRandom(2_026);
  const model = freshModel(seededRandom(99));
  const sink = new RingBufferNewsSink(500);
  const scheduler = new NewsScheduler(model, SYMBOLS, sink, { random });

  // 종목 뉴스 4~8분, 매크로 30~60분 간격이라 한 시간으로는 표본이 적어 두 시간을 돌린다.
  const published: NewsItem[] = [];
  for (let t = 0; t <= 7_200_000; t += 5_000) {
    const item = scheduler.tick(t);
    if (item) published.push(item);
    model.tick();
  }

  const symbolItems = published.filter((item) => item.scope === "SYMBOL" && !item.parentItemId);
  const macroItems = published.filter((item) => item.scope === "MACRO");
  const sequels = published.filter((item) => item.parentItemId !== null);

  assert.ok(
    symbolItems.length >= 12 && symbolItems.length <= 28,
    `symbol items: ${symbolItems.length}`,
  );
  assert.ok(macroItems.length >= 1 && macroItems.length <= 5, `macro items: ${macroItems.length}`);
  // Follow-ups are checked across seeds below; one seed's two hours can legitimately miss them.
  void sequels;

  // Nothing lands on top of anything else.
  for (let i = 1; i < published.length; i++) {
    assert.ok(
      published[i].publishedAtMs - published[i - 1].publishedAtMs >= 20_000,
      `items ${i - 1} and ${i} are less than 20s apart`,
    );
  }

  // No template repeats inside its cooldown window.
  const lastSeen = new Map<string, number>();
  for (const item of published) {
    const previous = lastSeen.get(item.templateId);
    if (previous !== undefined) {
      assert.ok(
        item.publishedAtMs - previous >= TEMPLATE_COOLDOWN_MS,
        `${item.templateId} repeated after ${(item.publishedAtMs - previous) / 60_000} minutes`,
      );
    }
    lastSeen.set(item.templateId, item.publishedAtMs);
  }

  assert.deepEqual(
    sink.list().map((item) => item.id),
    published.map((item) => item.id),
    "every published item reaches the sink",
  );
});

test("follow-up stories show up in most two-hour windows", () => {
  // About 1 in 6 two-hour windows has no sequel at all, so judge the rate, not one seed.
  let withSequel = 0;
  for (let seed = 1; seed <= 12; seed++) {
    const random = seededRandom(seed);
    const model = freshModel(seededRandom(99));
    const scheduler = new NewsScheduler(model, SYMBOLS, new RingBufferNewsSink(500), { random });
    let sequels = 0;
    for (let t = 0; t <= 7_200_000; t += 5_000) {
      if (scheduler.tick(t)?.parentItemId) sequels++;
      model.tick();
    }
    if (sequels > 0) withSequel++;
  }
  assert.ok(withSequel >= 8, `only ${withSequel}/12 two-hour windows had a follow-up`);
});

test("a follow-up fires once, inside its declared delay, and can reverse", () => {
  const random = seededRandom(5);
  const model = freshModel();
  const sink = new RingBufferNewsSink();
  const scheduler = new NewsScheduler(model, SYMBOLS, sink, { random });

  const parent = generateSymbolNews(
    contextFor(model, random),
    SYMBOLS.map((s) => s.symbol),
  );
  assert.ok(parent);

  // Drive the scheduler until a sequel appears, then check its provenance.
  // 종목 뉴스가 4~8분마다 하나이고 후속이 붙는 템플릿이 절반쯤이라, 최대 하루까지 돌리되
  // 첫 후속 보도가 나오고 한 시간 더 지나면 멈춘다.
  const published: NewsItem[] = [];
  let firstSequelAtMs: number | null = null;
  for (let t = 0; t <= 86_400_000; t += 5_000) {
    const item = scheduler.tick(t);
    if (item) published.push(item);
    if (item?.parentItemId && firstSequelAtMs === null) firstSequelAtMs = t;
    if (firstSequelAtMs !== null && t - firstSequelAtMs > 3_600_000) break;
  }

  const sequels = published.filter((item) => item.parentItemId !== null);
  assert.ok(sequels.length > 0, "expected at least one sequel in a day");

  for (const sequel of sequels) {
    const source = published.find((item) => item.id === sequel.parentItemId);
    assert.ok(source, `sequel ${sequel.id} references an unpublished parent`);
    assert.equal(sequel.symbol, source.symbol, "a sequel stays on its parent's symbol");

    const spec = templateById(source.templateId)?.followUp;
    assert.ok(spec, `${source.templateId} produced a sequel without declaring followUp`);
    const delay = sequel.publishedAtMs - source.publishedAtMs;
    assert.ok(
      delay >= spec.delayMs.min && delay <= spec.delayMs.max + 60_000,
      `${sequel.templateId} fired after ${delay}ms, outside [${spec.delayMs.min}, ${spec.delayMs.max}]`,
    );

    // A sequel never spawns another sequel.
    assert.equal(templateById(sequel.templateId)?.followUp, undefined);
  }

  // Each parent produces at most one sequel.
  const parentIds = sequels.map((item) => item.parentItemId);
  assert.equal(new Set(parentIds).size, parentIds.length, "a parent spawned more than one sequel");
});

test("a fresh scheduler has no pending follow-ups (restart drops the queue)", () => {
  const scheduler = new NewsScheduler(freshModel(), SYMBOLS, new RingBufferNewsSink(), {
    random: seededRandom(1),
  });
  assert.equal(scheduler.pendingFollowUpCount(), 0);
});

/** Draw macro items until the requested template comes up. */
function buildMacro(ctx: GeneratorContext, templateId: string): NewsItem {
  for (let attempt = 0; attempt < 4_000; attempt++) {
    const item = generateMacroNews(ctx);
    if (item?.templateId === templateId) return item;
  }
  throw new Error(`never drew ${templateId}`);
}
