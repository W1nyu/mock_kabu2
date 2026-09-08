import assert from "node:assert/strict";
import { test } from "node:test";
import { SYMBOLS } from "@mock-kabu/shared";
import { MAX_EVENT_STRENGTH, MIN_EVENT_STRENGTH } from "../market-model";
import { MACRO_POOL, NEWS_TEMPLATES, SEQUEL_POOL, SYMBOL_POOL, templateById } from "../news/catalog";
import { companyProfile } from "../news/company-profiles";
import { placeholderKeys } from "../news/slots";
import type { NewsTemplate } from "../news/types";

const AUTO_BOUND = new Set(["name", "symbol", "price"]);

function declaredKeys(template: NewsTemplate): Set<string> {
  return new Set(Object.keys(template.slots ?? {}));
}

function usedKeys(template: NewsTemplate): Set<string> {
  const used = new Set<string>();
  for (const pattern of [...template.headlines, ...(template.body ?? [])]) {
    for (const key of placeholderKeys(pattern)) used.add(key);
  }
  return used;
}

test("the catalog is large enough for an hour of watching without repeats", () => {
  // 45-minute template cooldown only works if the pool is much bigger than the
  // ~28 items an hour produces.
  assert.ok(SYMBOL_POOL.length >= 60, `symbol pool is ${SYMBOL_POOL.length}`);
  assert.ok(MACRO_POOL.length >= 12, `macro pool is ${MACRO_POOL.length}`);
  assert.ok(SEQUEL_POOL.length >= 12, `sequel pool is ${SEQUEL_POOL.length}`);
});

test("template ids are unique", () => {
  const seen = new Set<string>();
  for (const template of NEWS_TEMPLATES) {
    assert.ok(!seen.has(template.id), `duplicate template id: ${template.id}`);
    seen.add(template.id);
  }
});

test("every strength range sits inside the price model's accepted band", () => {
  for (const template of NEWS_TEMPLATES) {
    const { min, max } = template.strength;
    assert.ok(min <= max, `${template.id}: inverted strength range`);
    assert.ok(min >= MIN_EVENT_STRENGTH, `${template.id}: strength.min ${min} < ${MIN_EVENT_STRENGTH}`);
    assert.ok(max <= MAX_EVENT_STRENGTH, `${template.id}: strength.max ${max} > ${MAX_EVENT_STRENGTH}`);
  }
});

test("persistence and volume overrides stay inside what startEvent validates", () => {
  for (const template of NEWS_TEMPLATES) {
    if (template.persistence) {
      const { min, max } = template.persistence;
      assert.ok(min <= max, `${template.id}: inverted persistence range`);
      assert.ok(min > 0 && max < 1, `${template.id}: persistence must be in (0, 1)`);
      assert.ok(min >= 0.9, `${template.id}: persistence ${min} decays too fast to be visible`);
    }
    if (template.volumeMultiplier) {
      const { min, max } = template.volumeMultiplier;
      assert.ok(min <= max, `${template.id}: inverted volumeMultiplier range`);
      assert.ok(min >= 1 && max <= 2, `${template.id}: volumeMultiplier must be within [1, 2]`);
    }
  }
});

test("every placeholder resolves and every declared slot is used", () => {
  for (const template of NEWS_TEMPLATES) {
    const declared = declaredKeys(template);
    const used = usedKeys(template);

    for (const key of used) {
      assert.ok(
        declared.has(key) || AUTO_BOUND.has(key),
        `${template.id}: {${key}} is used but never declared`,
      );
    }
    for (const key of declared) {
      assert.ok(used.has(key), `${template.id}: slot "${key}" is declared but never used`);
    }
  }
});

test("macro templates declare a channel and direction, and name no company", () => {
  for (const template of NEWS_TEMPLATES) {
    if (template.scope === "MACRO") {
      assert.ok(template.macroChannel, `${template.id}: MACRO scope needs a macroChannel`);
      assert.ok(
        template.macroDirection === 1 || template.macroDirection === -1,
        `${template.id}: MACRO scope needs a macroDirection of 1 or -1`,
      );
      for (const pattern of [...template.headlines, ...(template.body ?? [])]) {
        assert.ok(
          !placeholderKeys(pattern).some((key) => AUTO_BOUND.has(key)),
          `${template.id}: a market-wide story must not name a company`,
        );
      }
    } else {
      assert.equal(template.macroChannel, undefined, `${template.id}: macroChannel on a symbol story`);
      assert.equal(
        template.macroDirection,
        undefined,
        `${template.id}: macroDirection on a symbol story`,
      );
    }
  }
});

test("the macro pool is balanced so its direction mix does not skew the market", () => {
  // Macro templates bypass the sentiment filter, so the pool itself has to be
  // roughly symmetric or the market picks up a permanent drift.
  const rising = MACRO_POOL.filter((template) => template.macroDirection === 1).length;
  assert.ok(
    Math.abs(rising - (MACRO_POOL.length - rising)) <= 2,
    `macro pool is lopsided: ${rising} rising vs ${MACRO_POOL.length - rising} falling`,
  );
});

test("follow-up outcomes are well formed and cap the chain at one sequel", () => {
  for (const template of NEWS_TEMPLATES) {
    if (!template.followUp) continue;

    assert.ok(
      !template.sequelOnly,
      `${template.id}: a sequel must not spawn another sequel (chain depth > 1)`,
    );

    const total = template.followUp.outcomes.reduce((sum, outcome) => sum + outcome.probability, 0);
    assert.ok(
      Math.abs(total - 1) < 1e-9,
      `${template.id}: follow-up probabilities sum to ${total}, expected 1`,
    );

    assert.ok(
      template.followUp.delayMs.min <= template.followUp.delayMs.max,
      `${template.id}: inverted follow-up delay`,
    );
    assert.ok(
      template.followUp.delayMs.max <= 720_000,
      `${template.id}: follow-up delay exceeds the 12-minute restart-loss cap`,
    );

    for (const outcome of template.followUp.outcomes) {
      const sequel = templateById(outcome.templateId);
      assert.ok(sequel, `${template.id}: unknown follow-up template ${outcome.templateId}`);
      assert.ok(
        sequel.sequelOnly,
        `${template.id}: ${outcome.templateId} is reachable by the primary picker`,
      );
    }
  }
});

test("sector gating keeps impossible stories away from the wrong company", () => {
  const kabu = companyProfile("KABU");
  assert.ok(kabu);

  const reachableForKabu = SYMBOL_POOL.filter(
    (template) =>
      !template.excludeSectors?.includes(kabu.sector) &&
      (!template.sectors || template.sectors.includes(kabu.sector)),
  ).map((template) => template.id);

  // A brokerage has no factory to burn down and no product to recall.
  assert.ok(!reachableForKabu.includes("risk.accident"));
  assert.ok(!reachableForKabu.includes("risk.recall"));
  assert.ok(!reachableForKabu.includes("biz.capex"));
  // But the broker-only story is reachable.
  assert.ok(reachableForKabu.includes("risk.pf"));
});

test("BIO templates stay dormant until a pharma listing exists", () => {
  const activeSectors = new Set(
    SYMBOLS.map((symbol) => companyProfile(symbol.symbol)?.sector).filter(Boolean),
  );
  assert.ok(!activeSectors.has("BIO"), "test assumes no BIO listing yet");

  const reachable = SYMBOL_POOL.filter(
    (template) => !template.sectors || template.sectors.some((sector) => activeSectors.has(sector)),
  ).map((template) => template.id);

  assert.ok(!reachable.includes("bio.trial.success"));
  assert.ok(!reachable.includes("bio.trial.fail"));
});

test("every listed symbol has a company profile", () => {
  for (const symbol of SYMBOLS) {
    assert.ok(companyProfile(symbol.symbol), `no profile for ${symbol.symbol}`);
  }
});
