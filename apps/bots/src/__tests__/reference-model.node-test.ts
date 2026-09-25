import assert from "node:assert/strict";
import { test } from "node:test";
import { REFERENCE_ASSETS, referenceAsset } from "@mock-kabu/shared";
import type { RandomSource } from "../market-model";
import { ReferenceNewsSink } from "../reference-engine";
import { ReferencePriceModel } from "../reference-model";
import type { NewsItem } from "../news/types";

function seeded(seed: number): RandomSource {
  let state = seed >>> 0;
  return {
    next() {
      state = (state * 1_664_525 + 1_013_904_223) >>> 0;
      return state / 0x1_0000_0000;
    },
  };
}

/** 같은 난수열을 쓰는 두 모델의 로그 차이 = 뉴스 효과만 */
function newsEffect(apply: (model: ReferencePriceModel) => void, seconds = 3 * 3_600) {
  const withNews = new ReferencePriceModel(seeded(11));
  const control = new ReferencePriceModel(seeded(11));
  apply(withNews);
  for (let t = 0; t < seconds; t += 10) {
    withNews.tick(10);
    control.tick(10);
  }
  return Object.fromEntries(
    REFERENCE_ASSETS.map((asset) => [asset.code, Math.log(withNews.value(asset.code) / control.value(asset.code))]),
  ) as Record<string, number>;
}

test("starts at the anchor, or resumes from a restored price", () => {
  const fresh = new ReferencePriceModel(seeded(1));
  assert.ok(Math.abs(fresh.value("USDKRW") - 1_400) < 1e-9);
  const resumed = new ReferencePriceModel(seeded(1), { OIL: 87.5 });
  assert.ok(Math.abs(resumed.value("OIL") - 87.5) < 1e-9);
  assert.deepEqual(resumed.snapshotUnits().OIL, 8_750);
  assert.deepEqual(fresh.snapshotUnits().USDKRW, 14_000);
});

test("realized volatility matches each asset's daily volatility", () => {
  const model = new ReferencePriceModel(seeded(7));
  const dt = 10;
  const steps = (20 * 86_400) / dt;
  const sums = new Map<string, { s: number; s2: number }>(REFERENCE_ASSETS.map((a) => [a.code, { s: 0, s2: 0 }]));
  let previous = Object.fromEntries(REFERENCE_ASSETS.map((a) => [a.code, model.value(a.code)]));
  for (let i = 0; i < steps; i++) {
    model.tick(dt);
    for (const asset of REFERENCE_ASSETS) {
      const r = Math.log(model.value(asset.code) / previous[asset.code]);
      const acc = sums.get(asset.code)!;
      acc.s += r;
      acc.s2 += r * r;
      previous[asset.code] = model.value(asset.code);
    }
  }
  for (const asset of REFERENCE_ASSETS) {
    const { s, s2 } = sums.get(asset.code)!;
    const variance = s2 / steps - (s / steps) ** 2;
    const daily = Math.sqrt(variance * (86_400 / dt));
    assert.ok(Math.abs(daily / asset.dailyVol - 1) < 0.05, `${asset.code}: realized ${daily} vs ${asset.dailyVol}`);
  }
});

test("mean reversion pulls a displaced price back toward the anchor", () => {
  const model = new ReferencePriceModel(seeded(3), { OIL: 150 });
  for (let t = 0; t < 30 * 86_400; t += 60) model.tick(60);
  const oil = model.value("OIL");
  assert.ok(oil < 120 && oil > 60, `oil after 30 days: ${oil}`);
});

test("an OPEC-style oil story moves oil fully, gas partly, and leaves copper and FX alone", () => {
  const effect = newsEffect((model) => model.applyNews({ channel: "OIL", direction: 1, strength: 1 }));
  const oil = referenceAsset("OIL")!;
  // 3시간이면 시간상수 4분 충격이 거의 전부 반영된다.
  assert.ok(Math.abs(effect.OIL - oil.dailyVol * 1.2) < 0.002, `oil ${effect.OIL}`);
  assert.ok(Math.abs(effect.GAS - 0.6 * referenceAsset("GAS")!.dailyVol * 1.2) < 0.003, `gas ${effect.GAS}`);
  assert.ok(Math.abs(effect.COPPER) < 1e-9 && Math.abs(effect.USDKRW) < 1e-9);
});

test("the impulse seeps in over minutes rather than jumping", () => {
  const early = newsEffect((model) => model.applyNews({ channel: "FX", direction: -1, strength: 1 }), 60);
  const late = newsEffect((model) => model.applyNews({ channel: "FX", direction: -1, strength: 1 }), 3_600);
  assert.ok(early.USDKRW < 0 && late.USDKRW < early.USDKRW, `early ${early.USDKRW}, late ${late.USDKRW}`);
  assert.ok(Math.abs(early.USDKRW) < Math.abs(late.USDKRW) * 0.4);
});

test("a story naming a commodity hits that commodity on top of its channel", () => {
  const copper = newsEffect((model) => model.applyNews({ channel: "COMMODITY", direction: 1, strength: 1, commodity: "구리" }));
  const nickel = newsEffect((model) => model.applyNews({ channel: "COMMODITY", direction: 1, strength: 1, commodity: "니켈" }));
  assert.ok(copper.COPPER > nickel.COPPER * 1.8, `named ${copper.COPPER} vs channel only ${nickel.COPPER}`);
  const gas = newsEffect((model) => model.applyNews({ channel: "COMMODITY", direction: -1, strength: 1, commodity: "천연가스" }));
  assert.ok(gas.GAS < 0, "a named gas story moves gas even on the metals channel");
});

test("only market-wide stories reach the reference prices", () => {
  const calls: unknown[] = [];
  const sink = new ReferenceNewsSink({ applyNews: (signal: unknown) => calls.push(signal) } as never);
  const base = { id: "1", headline: "", body: null, publishedAtMs: 0, parentItemId: null, industry: null, symbol: null };
  sink.publish({ ...base, templateId: "macro.opec.cut", scope: "MACRO", category: "MACRO", slotValues: {},
    impact: [{ symbol: "NRFD", sentiment: "POSITIVE", strength: 0.5 }] } as NewsItem);
  sink.publish({ ...base, templateId: "biz.order", scope: "SYMBOL", category: "BUSINESS", slotValues: {},
    impact: [{ symbol: "MOCK", sentiment: "POSITIVE", strength: 0.5 }] } as NewsItem);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { channel: "OIL", direction: 1, strength: 0.5, commodity: null });
});
