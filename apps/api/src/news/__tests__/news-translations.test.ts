import { describe, expect, it } from "vitest";
import { sanitizeTranslations } from "../news.service";

describe("news translations", () => {
  it("keeps only en/ja headline and body", () => {
    expect(sanitizeTranslations({ en: { headline: "Oil tops $100", body: null }, ja: { headline: "原油100ドル突破", body: "本文" } })).toEqual({
      en: { headline: "Oil tops $100", body: null },
      ja: { headline: "原油100ドル突破", body: "本文" },
    });
    expect(sanitizeTranslations({})).toEqual({});
  });

  it("rejects unknown languages, missing headlines and oversized text", () => {
    expect(sanitizeTranslations({ fr: { headline: "x" } })).toBeNull();
    expect(sanitizeTranslations({ en: { body: "x" } })).toBeNull();
    expect(sanitizeTranslations({ en: { headline: "x".repeat(401) } })).toBeNull();
    expect(sanitizeTranslations([])).toBeNull();
  });
});
