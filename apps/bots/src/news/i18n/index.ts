/**
 * 뉴스 다국어. 한국어 기사가 원문이고, 같은 템플릿·같은 숫자로 영어·일본어 기사를 함께 만든다.
 *
 *  - 템플릿 번역: templates-en.ts · templates-ja.ts (id → 헤드라인·본문, 자리표시자는 한국어와 같은 이름, 조사 자리는 없음)
 *  - 슬롯 값: slots.ts가 뽑을 때 세 언어로 함께 만든다(금액 단위·단위 명사·분기·어휘 번역).
 *  - 번역이 없거나 자리표시자가 안 맞으면 그 언어는 비워 둔다 — 화면이 한국어 원문을 보여 준다.
 */
import { TEMPLATES_EN } from "./templates-en";
import { TEMPLATES_JA } from "./templates-ja";

export type NewsLocale = "en" | "ja";
export const NEWS_LOCALES: readonly NewsLocale[] = ["en", "ja"];

export interface TemplateTranslation {
  /** 헤드라인 — 한국어 헤드라인과 같은 순서(개수가 적으면 번갈아 쓴다) */
  readonly h: readonly string[];
  /** 본문 — 한국어 본문과 같은 순서 */
  readonly b?: readonly string[];
}

/** 언어별 슬롯 값 */
export type LocalizedSlots = Record<NewsLocale, Record<string, string>>;

export interface NewsTranslation {
  readonly headline: string;
  readonly body: string | null;
}
export type NewsTranslations = Partial<Record<NewsLocale, NewsTranslation>>;

export const TEMPLATE_TRANSLATIONS: Record<NewsLocale, Readonly<Record<string, TemplateTranslation>>> = {
  en: TEMPLATES_EN,
  ja: TEMPLATES_JA,
};

export function emptyLocalizedSlots(): LocalizedSlots {
  return { en: {}, ja: {} };
}

const PLACEHOLDER = /\{([a-zA-Z0-9_]+)\}/g;

/** 조사 없는 단순 치환. 값이 빠진 자리가 있으면 null(그 언어는 만들지 않는다). */
export function renderPlain(pattern: string, values: Readonly<Record<string, string>>): string | null {
  let missing = false;
  const text = pattern.replace(PLACEHOLDER, (all, key: string) => {
    const value = values[key];
    if (value === undefined) {
      missing = true;
      return all;
    }
    return value;
  });
  return missing ? null : text;
}

/** 한국어로 고른 헤드라인·본문 번호로 각 언어 기사를 그린다. */
export function renderTranslations(
  templateId: string,
  headlineIndex: number,
  bodyIndex: number | null,
  localized: LocalizedSlots,
): NewsTranslations | undefined {
  const out: NewsTranslations = {};
  for (const locale of NEWS_LOCALES) {
    const translation = TEMPLATE_TRANSLATIONS[locale][templateId];
    if (!translation || translation.h.length === 0) continue;
    const headline = renderPlain(translation.h[headlineIndex % translation.h.length], localized[locale]);
    if (headline == null) continue;
    let body: string | null = null;
    if (bodyIndex != null && translation.b && translation.b.length > 0) {
      body = renderPlain(translation.b[bodyIndex % translation.b.length], localized[locale]);
    }
    out[locale] = { headline, body };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
