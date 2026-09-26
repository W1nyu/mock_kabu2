/**
 * 다국어(한국어·영어·일본어) 공용 정의 — 언어 코드, 종목·업종·기초자산·선물·옵션 이름.
 * 한국어가 원문이고, 영어·일본어는 여기서 옮긴다. 화면 문구 사전은 웹(apps/web/src/lib/i18n)에 있다.
 */
import { optionDef } from "./options";

export type Locale = "ko" | "en" | "ja";
export const LOCALES: readonly Locale[] = ["ko", "en", "ja"];
export const DEFAULT_LOCALE: Locale = "ko";
/** 웹이 언어를 저장하는 쿠키, API에 알려 주는 헤더 */
export const LOCALE_COOKIE = "mk_locale";
export const LOCALE_HEADER = "x-locale";

export function isLocale(value: unknown): value is Locale {
  return value === "ko" || value === "en" || value === "ja";
}

/** Accept-Language 등 언어 태그 목록에서 지원 언어를 고른다(없으면 한국어). */
export function pickLocale(acceptLanguage: string | null | undefined): Locale {
  if (!acceptLanguage) return DEFAULT_LOCALE;
  const tags = acceptLanguage
    .split(",")
    .map((part) => {
      const [tag, q] = part.trim().split(";q=");
      return { tag: tag.toLowerCase(), q: q ? Number(q) : 1 };
    })
    .sort((a, b) => b.q - a.q);
  for (const { tag } of tags) {
    const base = tag.split("-")[0];
    if (isLocale(base)) return base;
  }
  return DEFAULT_LOCALE;
}

type Names = Readonly<Record<string, { en: string; ja: string }>>;

const SYMBOL_NAMES: Names = {
  KABU: { en: "Kabu Securities", ja: "カブ証券" },
  SAKU: { en: "Sakura Heavy Industries", ja: "サクラ重工業" },
  NEKO: { en: "Neko Trading", ja: "ネコ物産" },
  BORI: { en: "Bori Foods", ja: "ボリ食品" },
  BJAY: { en: "Blue Jay Air", ja: "ブルージェイ航空" },
  SKYL: { en: "Skylink", ja: "スカイリンク" },
  DAON: { en: "Daon Semiconductor", ja: "ダオン半導体" },
  DDAM: { en: "Dodam Construction", ja: "ドダム建設" },
  SAEM: { en: "Saemmul Bio", ja: "セムルバイオ" },
  STEL: { en: "Stella Entertainment", ja: "ステラエンター" },
  SLVR: { en: "Silver Motors", ja: "シルバーモーターズ" },
  NOVA: { en: "Novacell Battery", ja: "ノバセルバッテリー" },
  NRFD: { en: "Northfield Refining", ja: "ノースフィールド精油" },
  GARM: { en: "Garam Power", ja: "ガラム電力" },
  HAVN: { en: "Haven REIT", ja: "ヘイブンリート" },
  // 상장 폐지
  MOCK: { en: "Mock Electronics", ja: "モック電子" },
  TANU: { en: "Tanuki Trading", ja: "タヌキ商事" },
  PIXL: { en: "Pixel Games", ja: "ピクセルゲームズ" },
};

const INDUSTRY_LABELS: Names = {
  tech: { en: "IT & Semiconductors", ja: "IT・半導体" },
  battery: { en: "Batteries & Materials", ja: "二次電池・素材" },
  industrial: { en: "Industrials", ja: "資本財" },
  mobility: { en: "Mobility", ja: "モビリティ" },
  media: { en: "Media & Telecom", ja: "メディア・通信" },
  health: { en: "Healthcare", ja: "ヘルスケア" },
  energy: { en: "Energy & Utilities", ja: "エネルギー・公益" },
  consumer: { en: "Consumer Goods", ja: "消費財" },
  finance: { en: "Finance & Real Estate", ja: "金融・不動産" },
};

const REFERENCE_NAMES: Names = {
  USDKRW: { en: "USD/KRW", ja: "ドル/ウォン" },
  OIL: { en: "Crude Oil", ja: "原油" },
  GAS: { en: "Natural Gas", ja: "天然ガス" },
  COPPER: { en: "Copper", ja: "銅" },
  GOLD: { en: "Gold", ja: "金" },
  CORN: { en: "Corn", ja: "トウモロコシ" },
};

const FUTURE_NAMES: Names = {
  KABUF: { en: "Stock Index Futures", ja: "株価指数先物" },
  USDF: { en: "USD/KRW Futures", ja: "ドル/ウォン先物" },
  OILF: { en: "Crude Oil Futures", ja: "原油先物" },
  GASF: { en: "Natural Gas Futures", ja: "天然ガス先物" },
  CPRF: { en: "Copper Futures", ja: "銅先物" },
  GOLDF: { en: "Gold Futures", ja: "金先物" },
  CORNF: { en: "Corn Futures", ja: "トウモロコシ先物" },
};

const OPTION_FAMILY_NAMES: Names = {
  K: { en: "Stock Index", ja: "株価指数" },
  U: { en: "USD/KRW", ja: "ドル/ウォン" },
  KCOM: { en: "Commodity Index", ja: "商品指数" },
};

function pick(names: Names, key: string, locale: Locale, ko: string): string {
  if (locale === "ko") return ko;
  return names[key]?.[locale] ?? ko;
}

/** 종목 이름 — `ko`는 원래 이름(SYMBOLS의 name) */
export function localizedSymbolName(symbol: string, ko: string, locale: Locale): string {
  return pick(SYMBOL_NAMES, symbol, locale, ko);
}

export function localizedIndustryLabel(id: string, ko: string, locale: Locale): string {
  return pick(INDUSTRY_LABELS, id, locale, ko);
}

export function localizedReferenceName(code: string, ko: string, locale: Locale): string {
  return pick(REFERENCE_NAMES, code, locale, ko);
}

export function localizedFutureName(symbol: string, ko: string, locale: Locale): string {
  return pick(FUTURE_NAMES, symbol, locale, ko);
}

export function localizedOptionFamilyName(code: string, ko: string, locale: Locale): string {
  return pick(OPTION_FAMILY_NAMES, code, locale, ko);
}

/** 옵션 종목 이름 "원자재지수 콜 3" / "Commodity Index Call 3" / "商品指数 コール 3" */
export function localizedOptionName(symbol: string, locale: Locale): string {
  const def = optionDef(symbol);
  if (!def) return symbol;
  if (locale === "ko") return def.name;
  const family = localizedOptionFamilyName(def.family.code, def.family.name, locale);
  const type = locale === "en" ? (def.type === "CALL" ? "Call" : "Put") : def.type === "CALL" ? "コール" : "プット";
  return `${family} ${type} ${def.slot}`;
}

/** 원화 금액 표기: 1,234원 / ₩1,234 / 1,234ウォン */
export function formatWon(text: string, locale: Locale): string {
  if (locale === "en") return text.startsWith("-") ? `-₩${text.slice(1)}` : `₩${text}`;
  if (locale === "ja") return `${text}ウォン`;
  return `${text}원`;
}
