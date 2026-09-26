"use client";

/**
 * 화면 다국어(한국어·영어·일본어).
 *
 * 한국어 원문을 그대로 키로 쓴다: `t("주문 가능 금액")`, `t("{n}계약", { n })`.
 * 사전(messages.ts: 한국어 → [영어, 일본어])에 없으면 한국어가 나온다. 빠진 번역은 `node scripts/i18n-missing.mjs`로 찾는다.
 *
 * 언어는 쿠키(mk_locale)에 저장하고, 없으면 서버가 Accept-Language로 고른다(layout.tsx) — 첫 화면부터 그 언어로
 * 그려 깜박임이 없다. API 요청에는 x-locale 헤더로 알려 오류 메시지·뉴스를 같은 언어로 받는다.
 */
import {
  DEFAULT_LOCALE,
  LOCALE_COOKIE,
  localizedFutureName,
  localizedIndustryLabel,
  localizedOptionFamilyName,
  localizedOptionName,
  localizedReferenceName,
  localizedSymbolName,
  localizeServerMessage,
  type Locale,
} from "@mock-kabu/shared";
import { createContext, Fragment, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { MESSAGES } from "./messages";

export type { Locale };
export type Vars = Record<string, string | number>;

const INDEX: Record<Exclude<Locale, "ko">, 0 | 1> = { en: 0, ja: 1 };

/**
 * 지금 화면 언어 — 훅을 쓸 수 없는 곳(api()의 헤더, won() 같은 표기 함수)을 위한 값.
 * 브라우저에서는 탭마다 하나라 안전하다. 서버 렌더는 요청이 겹칠 수 있지만, 서버에서 그리는 첫 화면은
 * 대부분 데이터가 없는 뼈대라 금액 표기가 섞일 일이 거의 없다.
 */
let currentLocale: Locale = DEFAULT_LOCALE;
export function getLocale(): Locale {
  return currentLocale;
}

function interpolate(text: string, vars?: Vars): string {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match));
}

/** 서버가 보낸 한국어 문장(오류·실패 사유·메모)을 지금 화면 언어로 */
export function serverText(message: string | null | undefined): string {
  return message ? localizeServerMessage(message, currentLocale) : "";
}

/**
 * 훅 밖에서 쓰는 번역. 같은 한국어가 뜻에 따라 다르게 옮겨지면 `"취소|동작"`처럼 `|` 뒤에 구분을 붙인다 —
 * 한국어 화면에는 `|` 앞만 나온다.
 */
export function translate(locale: Locale, ko: string, vars?: Vars): string {
  const plain = ko.includes("|") ? ko.slice(0, ko.indexOf("|")) : ko;
  const text = locale === "ko" ? plain : (MESSAGES[ko]?.[INDEX[locale]] ?? plain);
  return interpolate(text, vars);
}

export type TFunction = (ko: string, vars?: Vars) => string;

interface I18nValue {
  locale: Locale;
  setLocale: (next: Locale) => void;
  t: TFunction;
}

const I18nContext = createContext<I18nValue>({
  locale: DEFAULT_LOCALE,
  setLocale: () => {},
  t: (ko, vars) => interpolate(ko, vars),
});

export function I18nProvider({ initialLocale, children }: { initialLocale: Locale; children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);
  // 자식이 그려지기 전에 맞춰 둔다(won()·api()가 이 값을 읽는다).
  currentLocale = locale;

  const setLocale = useCallback((next: Locale) => {
    currentLocale = next;
    document.cookie = `${LOCALE_COOKIE}=${next}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
    document.documentElement.lang = next;
    setLocaleState(next);
  }, []);

  const value = useMemo<I18nValue>(
    () => ({ locale, setLocale, t: (ko, vars) => translate(locale, ko, vars) }),
    [locale, setLocale],
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  return useContext(I18nContext);
}

/** 가장 흔한 사용 — `const t = useT();` */
export function useT(): TFunction {
  return useContext(I18nContext).t;
}

/** 이름 번역 묶음 — 종목·업종·기초자산·선물·옵션 */
export function useNames() {
  const { locale } = useI18n();
  return useMemo(
    () => ({
      symbol: (symbol: string, ko: string) => localizedSymbolName(symbol, ko, locale),
      industry: (id: string, ko: string) => localizedIndustryLabel(id, ko, locale),
      reference: (code: string, ko: string) => localizedReferenceName(code, ko, locale),
      future: (symbol: string, ko: string) => localizedFutureName(symbol, ko, locale),
      optionFamily: (code: string, ko: string) => localizedOptionFamilyName(code, ko, locale),
      option: (symbol: string) => localizedOptionName(symbol, locale),
    }),
    [locale],
  );
}

/**
 * 번역된 문장 속 {이름} 자리에 링크 같은 요소를 끼운다 — 언어마다 어순이 달라 문장을 쪼개지 않는다.
 *   rich(t("선물 주문은 {login} 후 이용할 수 있습니다."), { login: <Link href="/login">{t("로그인")}</Link> })
 */
export function rich(text: string, nodes: Record<string, ReactNode>): ReactNode {
  const parts = text.split(/(\{\w+\})/g);
  return parts.map((part, index) => {
    const match = /^\{(\w+)\}$/.exec(part);
    return <Fragment key={index}>{match && match[1] in nodes ? nodes[match[1]] : part}</Fragment>;
  });
}

export const LOCALE_LABELS: Record<Locale, string> = { ko: "한국어", en: "English", ja: "日本語" };
