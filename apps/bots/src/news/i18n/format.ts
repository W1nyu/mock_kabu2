/**
 * 뉴스 슬롯 값의 영어·일본어 표기. 한국어 표기는 slots.ts가 만든다.
 */
import { localizedSymbolName } from "@mock-kabu/shared";
import { VOCAB_I18N } from "./vocab";
import type { NewsLocale } from "./index";

const en = new Intl.NumberFormat("en-US");
const ja = new Intl.NumberFormat("ja-JP");

/** 억원 → ₩320B (영어·일본어 같은 표기, 반올림된 억 단위를 받는다) */
export function formatEokLocale(eok: number, _locale: NewsLocale): string {
  // 1억 = 1억 원 = 100M
  const won = eok * 100_000_000;
  if (won >= 1_000_000_000_000) return `₩${trim(won / 1_000_000_000_000)}T`;
  if (won >= 1_000_000_000) return `₩${trim(won / 1_000_000_000)}B`;
  return `₩${trim(won / 1_000_000)}M`;
}

function trim(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return en.format(rounded);
}

/** 원화 가격 → ₩12,000 (영어·일본어 같은 표기) */
export function formatWonLocale(value: number, _locale: NewsLocale): string {
  return `₩${en.format(value)}`;
}

/** level 슬롯(환율·유가 수준) — 단위: 원·달러·없음 */
export function formatLevelLocale(text: string, unit: string, locale: NewsLocale): string {
  if (unit === "원") return `₩${text}`;
  if (unit === "달러") return locale === "en" ? `$${text}` : `${text}ドル`;
  return text;
}

const COUNT_UNITS_JA: Record<string, string> = {
  주: "株",
  건: "件",
  개: "個",
  점: "点",
  "만 건": "万件",
  대: "台",
  년: "年",
  장: "枚",
  회: "回",
  명: "人",
  가구: "世帯",
  척: "隻",
  차례: "回",
  "만 명": "万人",
  "만 배럴": "万バレル",
  개월: "か月",
  종: "種",
  기: "基",
  곳: "か所",
};

/** count 슬롯 — 영어는 숫자만(명사는 번역 템플릿이 붙인다, 만 단위는 풀어 쓴다), 일본어는 숫자+단위 */
export function formatCountLocale(value: number, unit: string, locale: NewsLocale): string {
  if (locale === "en") return en.format(unit.startsWith("만 ") ? value * 10_000 : value);
  return `${ja.format(value)}${COUNT_UNITS_JA[unit] ?? unit}`;
}

const DURATION_EN: Record<string, [string, string]> = {
  일: ["day", "days"],
  거래일: ["trading day", "trading days"],
  개월: ["month", "months"],
  년: ["year", "years"],
  분기: ["quarter", "quarters"],
};
const DURATION_JA: Record<string, string> = { 일: "日", 거래일: "営業日", 개월: "か月", 년: "年", 분기: "四半期" };

export function formatDurationLocale(value: number, unit: string, locale: NewsLocale): string {
  if (locale === "en") {
    const [one, many] = DURATION_EN[unit] ?? [unit, unit];
    return `${value} ${value === 1 ? one : many}`;
  }
  return `${value}${DURATION_JA[unit] ?? unit}`;
}

/** "2분기" → Q2 / 第2四半期 */
export function formatQuarterLocale(quarter: number, locale: NewsLocale): string {
  return locale === "en" ? `Q${quarter}` : `第${quarter}四半期`;
}

/** 어휘(증권사·국가·제품·공장 지명 등) 번역. 없으면 한국어 그대로(테스트가 빠진 것을 잡는다). */
export function vocabLocale(value: string, locale: NewsLocale): string {
  const entry = VOCAB_I18N[value];
  return entry ? entry[locale === "en" ? 0 : 1] : value;
}

export function symbolNameLocale(symbol: string, ko: string, locale: NewsLocale): string {
  return localizedSymbolName(symbol, ko, locale);
}
