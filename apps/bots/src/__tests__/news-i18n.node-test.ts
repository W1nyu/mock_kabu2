import assert from "node:assert/strict";
import { test } from "node:test";
import { SYMBOLS } from "@mock-kabu/shared";
import { MarketModel, type RandomSource } from "../market-model";
import { NEWS_TEMPLATES } from "../news/catalog";
import { COMPANY_PROFILES } from "../news/company-profiles";
import { generateMacroNews, generateSectorNews, generateSymbolNews, type GeneratorContext } from "../news/generator";
import { NEWS_LOCALES, TEMPLATE_TRANSLATIONS } from "../news/i18n";
import { formatEokLocale } from "../news/i18n/format";
import { VOCAB_I18N } from "../news/i18n/vocab";
import { RecentNewsMemory } from "../news/memory";
import { placeholderKeys } from "../news/slots";
import { GLOBAL_VOCAB, SECTOR_VOCAB } from "../news/vocab";

const PLACEHOLDER = /\{([a-zA-Z0-9_]+)\}/g;
const AUTO_BOUND = new Set(["name", "symbol", "price"]);
const HANGUL = /[가-힣]/;

test("every news template has an English and a Japanese translation using only its own slots", () => {
  for (const template of NEWS_TEMPLATES) {
    const allowed = new Set([...Object.keys(template.slots ?? {}), ...AUTO_BOUND]);
    const koKeys = new Set(template.headlines.flatMap((h) => placeholderKeys(h)));
    for (const locale of NEWS_LOCALES) {
      const translation = TEMPLATE_TRANSLATIONS[locale][template.id];
      assert.ok(translation, `${template.id} has no ${locale} translation`);
      assert.ok(translation.h.length > 0, `${template.id} ${locale} has no headline`);
      if (template.body?.length) assert.ok(translation.b?.length, `${template.id} ${locale} is missing the body`);
      for (const pattern of [...translation.h, ...(translation.b ?? [])]) {
        assert.ok(!HANGUL.test(pattern), `${template.id} ${locale} still contains Korean: ${pattern}`);
        for (const match of pattern.matchAll(PLACEHOLDER)) {
          assert.ok(allowed.has(match[1]), `${template.id} ${locale} uses unknown slot {${match[1]}}`);
        }
      }
      // 헤드라인이 다루는 대상(종목 이름)을 번역에서도 빠뜨리지 않는다.
      if (koKeys.has("name")) {
        assert.ok(
          translation.h.every((h) => h.includes("{name}")),
          `${template.id} ${locale} headline drops {name}`,
        );
      }
    }
  }
  for (const locale of NEWS_LOCALES) {
    const known = new Set(NEWS_TEMPLATES.map((template) => template.id));
    for (const id of Object.keys(TEMPLATE_TRANSLATIONS[locale])) assert.ok(known.has(id), `${locale} has stale id ${id}`);
  }
});

test("every vocabulary word and plant name has a translation", () => {
  const words = new Set<string>();
  for (const list of Object.values(GLOBAL_VOCAB)) list.forEach((word) => words.add(word));
  for (const sector of Object.values(SECTOR_VOCAB)) for (const list of Object.values(sector ?? {})) list?.forEach((word) => words.add(word));
  for (const profile of COMPANY_PROFILES) profile.plants.forEach((plant) => words.add(plant));
  const missing = [...words].filter((word) => !VOCAB_I18N[word]);
  assert.deepEqual(missing, []);
});

test("money is written the way each market reads it", () => {
  assert.equal(formatEokLocale(3_200, "en"), "₩320B");
  assert.equal(formatEokLocale(12_000, "en"), "₩1.2T");
  assert.equal(formatEokLocale(5, "en"), "₩500M");
  assert.equal(formatEokLocale(3_200, "ja"), "₩320B");
  assert.equal(formatEokLocale(12_000, "ja"), "₩1.2T");
});

function seededRandom(seed: number): RandomSource {
  let state = seed >>> 0;
  return {
    next() {
      state = (state * 1_664_525 + 1_013_904_223) >>> 0;
      return state / 0x1_0000_0000;
    },
  };
}

test("generated stories carry complete English and Japanese versions with no Korean left", () => {
  const random = seededRandom(42);
  const model = new MarketModel(SYMBOLS, { random, eventSpawnChance: 0 });
  let sequence = 0;
  const ctx: GeneratorContext = {
    nowMs: 0,
    random,
    symbols: SYMBOLS,
    sidewaysScores: new Map(SYMBOLS.map((s) => [s.symbol, model.sidewaysScore(s.symbol)])),
    prices: new Map(SYMBOLS.map((s) => [s.symbol, model.get(s.symbol)])),
    memory: new RecentNewsMemory(),
    nextSequence: () => ++sequence,
  };
  const eligible = SYMBOLS.map((s) => s.symbol);
  let checked = 0;
  for (let i = 0; i < 150; i++) {
    const item =
      i % 3 === 0 ? generateSymbolNews(ctx, eligible) : i % 3 === 1 ? generateMacroNews(ctx) : generateSectorNews(ctx);
    if (!item) continue;
    for (const locale of NEWS_LOCALES) {
      const translation = item.translations?.[locale];
      assert.ok(translation, `${item.templateId} has no ${locale} story`);
      assert.ok(!HANGUL.test(translation.headline), `${item.templateId} ${locale}: ${translation.headline}`);
      if (locale === "en") assert.ok(!/^[a-z]/.test(translation.headline), `${item.templateId} en starts lowercase: ${translation.headline}`);
      if (item.body) assert.ok(translation.body, `${item.templateId} ${locale} lost its body`);
      if (translation.body) assert.ok(!HANGUL.test(translation.body), `${item.templateId} ${locale}: ${translation.body}`);
    }
    checked++;
  }
  assert.ok(checked > 100);
});
