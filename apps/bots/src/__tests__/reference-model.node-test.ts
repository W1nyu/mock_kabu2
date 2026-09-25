import assert from "node:assert/strict";
import { test } from "node:test";
import { COMMODITY_REFERENCE_WEIGHTS, REFERENCE_ASSETS, referenceNewsMove } from "@mock-kabu/shared";
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

test("a news move lands half at once and the rest over minutes, ending at the full move", () => {
  const move = referenceNewsMove("OIL", 1, 1, 1);
  const instant = newsEffect((model) => model.applyMove("OIL", move), 1);
  const late = newsEffect((model) => model.applyMove("OIL", move), 3 * 3_600);
  assert.ok(Math.abs(instant.OIL - move / 2) < move * 0.05, `instant ${instant.OIL} vs ${move / 2}`);
  assert.ok(Math.abs(late.OIL - move) < 0.002, `late ${late.OIL} vs ${move}`);
  assert.ok(Math.abs(late.COPPER) < 1e-9 && Math.abs(late.USDKRW) < 1e-9, "other assets untouched");
});

test("commodity stories move only the asset they name (or a related metal, partly)", () => {
  assert.deepEqual(COMMODITY_REFERENCE_WEIGHTS["구리"], { COPPER: 1 });
  assert.equal(COMMODITY_REFERENCE_WEIGHTS["니켈"].COPPER, 0.5);
  assert.equal(COMMODITY_REFERENCE_WEIGHTS["천연가스"].GAS, 1);
  assert.equal(COMMODITY_REFERENCE_WEIGHTS["천연가스"].COPPER, undefined);
  assert.deepEqual(COMMODITY_REFERENCE_WEIGHTS["리튬"], {});
});

test("the sink applies exactly the moves the generator attached to the story", () => {
  const calls: [string, number][] = [];
  const sink = new ReferenceNewsSink({ applyMove: (code: string, move: number) => calls.push([code, move]) } as never);
  const base = { id: "1", headline: "", body: null, publishedAtMs: 0, parentItemId: null, industry: null, symbol: null, slotValues: {}, impact: [] };
  sink.publish({ ...base, templateId: "macro.opec.cut", scope: "MACRO", category: "MACRO",
    referenceMoves: [{ code: "OIL", move: 0.02 }, { code: "GAS", move: 0.01 }] } as unknown as NewsItem);
  sink.publish({ ...base, templateId: "biz.order", scope: "SYMBOL", category: "BUSINESS" } as unknown as NewsItem);
  assert.deepEqual(calls, [["OIL", 0.02], ["GAS", 0.01]]);
});
