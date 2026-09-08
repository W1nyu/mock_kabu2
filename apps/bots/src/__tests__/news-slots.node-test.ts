import assert from "node:assert/strict";
import { test } from "node:test";
import { SYMBOLS } from "@mock-kabu/shared";
import { companyProfile } from "../news/company-profiles";
import {
  bindSlots,
  formatEok,
  NO_VOCAB_MEMORY,
  quarterLabel,
  renderTemplate,
  roundEok,
  placeholderKeys,
  roundNicePrice,
  snapToTick,
  type SlotContext,
} from "../news/slots";
import type { NewsTemplate } from "../news/types";

const symbolFor = (code: string) => SYMBOLS.find((s) => s.symbol === code)!;

/** Cycles a fixed sequence so every draw in a test is reproducible. */
function sequenceRandom(values: readonly number[]) {
  let index = 0;
  return { next: () => values[index++ % values.length] };
}

test("roundEok quotes each magnitude at the precision a filing would use", () => {
  assert.equal(roundEok(7.4), 7);
  assert.equal(roundEok(83), 85);
  assert.equal(roundEok(642), 640);
  assert.equal(roundEok(3_247), 3_200);
  assert.equal(roundEok(13_400), 13_000);
});

test("formatEok switches to 조 above a trillion and drops a zero remainder", () => {
  assert.equal(formatEok(7.4), "7억원");
  assert.equal(formatEok(642), "640억원");
  assert.equal(formatEok(3_247), "3,200억원");
  assert.equal(formatEok(13_400), "1조 3,000억원");
  assert.equal(formatEok(20_100), "2조원");
});

test("a figure just under a trillion promotes instead of printing 9,960억", () => {
  // Rounding happens before the 조 split, so the two branches cannot disagree.
  assert.equal(formatEok(9_960), "1조원");
});

test("target prices land on round numbers that are legal ticks", () => {
  const saku = symbolFor("SAKU");
  assert.equal(roundNicePrice(345_000), 350_000);
  assert.equal(snapToTick(roundNicePrice(345_000), saku.tickSize), 350_000);

  const tanu = symbolFor("TANU");
  const target = snapToTick(roundNicePrice(8_000 * 1.15), tanu.tickSize);
  assert.equal(target % tanu.tickSize, 0);
});

test("quarterLabel offsets whole quarters and wraps the year boundary", () => {
  const feb2026 = Date.UTC(2026, 1, 15);
  assert.equal(quarterLabel(feb2026, 0), "1분기");
  assert.equal(quarterLabel(feb2026, -1), "4분기");
  assert.equal(quarterLabel(feb2026, 1), "2분기");
});

const ORDER_TEMPLATE: NewsTemplate = {
  id: "test.order",
  category: "BUSINESS",
  scope: "SYMBOL",
  sentiment: "POSITIVE",
  strength: { min: 0.45, max: 0.72 },
  headlines: ["{name}, {money} 규모 수주"],
  slots: { money: { kind: "money", capFraction: { min: 0.03, max: 0.22 } } },
};

function contextFor(code: string, random: { next(): number }): SlotContext {
  const symbol = symbolFor(code);
  return {
    random,
    nowMs: Date.UTC(2026, 8, 7),
    symbol,
    profile: companyProfile(code),
    price: symbol.initialPrice,
    memory: NO_VOCAB_MEMORY,
  };
}

test("money slots scale with the company, not the share price alone", () => {
  // Same template, same RNG draw — only the company differs.
  const draw = () => sequenceRandom([0.5]);
  const saku = bindSlots(ORDER_TEMPLATE, contextFor("SAKU", draw()));
  const tanu = bindSlots(ORDER_TEMPLATE, contextFor("TANU", draw()));

  const toEok = (text: string) => {
    const jo = /(\d+)조/.exec(text);
    const eok = /(?:조\s)?([\d,]+)억/.exec(text);
    return (jo ? Number(jo[1]) * 10_000 : 0) + (eok ? Number(eok[1].replace(/,/g, "")) : 0);
  };

  assert.ok(
    toEok(saku.money) > toEok(tanu.money),
    `expected SAKU(${saku.money}) > TANU(${tanu.money})`,
  );
});

test("rendering is deterministic for a fixed seed", () => {
  const first = bindSlots(ORDER_TEMPLATE, contextFor("SAKU", sequenceRandom([0.42])));
  const second = bindSlots(ORDER_TEMPLATE, contextFor("SAKU", sequenceRandom([0.42])));
  assert.deepEqual(first, second);
  assert.equal(
    renderTemplate(ORDER_TEMPLATE.headlines[0], first),
    `사쿠라중공업, ${first.money} 규모 수주`,
  );
});

test("a sequel inherits its parent's figures instead of resampling them", () => {
  const parent = bindSlots(ORDER_TEMPLATE, contextFor("SAKU", sequenceRandom([0.8])));
  const sequel = bindSlots(ORDER_TEMPLATE, {
    ...contextFor("SAKU", sequenceRandom([0.1])),
    inherited: parent,
  });
  assert.equal(sequel.money, parent.money);
});

test("an unresolved placeholder throws rather than printing a raw brace", () => {
  assert.throws(() => renderTemplate("{name}, {missing} 체결", { name: "카부증권" }), /missing/);
});

test("particles agree with whatever the slot actually rendered", () => {
  // 모의전자 ends open → 를; 카부증권 ends in a consonant → 을.
  assert.equal(renderTemplate("{name}{를} 톱픽으로", { name: "모의전자" }), "모의전자를 톱픽으로");
  assert.equal(renderTemplate("{name}{를} 톱픽으로", { name: "카부증권" }), "카부증권을 톱픽으로");

  assert.equal(renderTemplate("{c}{과} 계약", { c: "빅테크 기업" }), "빅테크 기업과 계약");
  assert.equal(renderTemplate("{c}{과} 계약", { c: "대형 선사" }), "대형 선사와 계약");

  // 로 treats a ㄹ ending as open: 서울로, not 서울으로.
  assert.equal(renderTemplate("{c}{로}부터", { c: "종합상사" }), "종합상사로부터");
  assert.equal(renderTemplate("{c}{로}부터", { c: "완성차 A사" }), "완성차 A사로부터");
});

test("a particle marker is not treated as a slot the template must declare", () => {
  assert.deepEqual(placeholderKeys("{name}{를} 톱픽으로"), ["name"]);
});

test("plant slots use the company's own sites, not a generic label", () => {
  const template: NewsTemplate = {
    id: "test.plant",
    category: "RISK",
    scope: "SYMBOL",
    sentiment: "NEGATIVE",
    strength: { min: 0.3, max: 0.4 },
    headlines: ["{name} {plant} 공장 화재"],
    slots: { plant: { kind: "pick", vocab: "plant" } },
  };
  const values = bindSlots(template, contextFor("SAKU", sequenceRandom([0.3])));
  // Not "제1공장", which would render as "제1공장 공장 화재".
  assert.ok(["거제", "울산", "군산"].includes(values.plant), `got ${values.plant}`);
});

test("a sequel does not inherit measurements that mean something different", () => {
  const parent = { money: "3,200억원", pct: "23.8%", country: "미국" };
  const template: NewsTemplate = {
    id: "test.sequel",
    category: "SEQUEL",
    scope: "SYMBOL",
    sentiment: "NEGATIVE",
    sequelOnly: true,
    strength: { min: 0.3, max: 0.4 },
    headlines: ["{name} {money}, {country} 할인율 {pct}"],
    slots: {
      money: { kind: "money", capFraction: { min: 0.01, max: 0.02 } },
      country: { kind: "pick", vocab: "country" },
      pct: { kind: "percent", range: { min: 5, max: 9 } },
    },
  };
  const values = bindSlots(template, {
    ...contextFor("SAKU", sequenceRandom([0.5])),
    inherited: parent,
  });

  // Story identity carries over…
  assert.equal(values.money, "3,200억원");
  assert.equal(values.country, "미국");
  // …but a percentage that means a different thing is resampled.
  assert.notEqual(values.pct, "23.8%");
});
