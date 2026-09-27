import {
  FUTURES,
  LOCALES,
  REFERENCE_ASSETS,
  SYMBOLS,
  localizedFutureName,
  localizedReferenceName,
  localizedSymbolName,
  type Locale,
} from "@mock-kabu/shared";

/**
 * 종목 검색 — 현물·선물·환율/원자재를 코드, 세 언어 이름, 한글 초성(ㄷㅇ → 다온반도체)으로 찾는다.
 * 상장 폐지 종목(DELISTED_SYMBOLS)과 옵션(종목 수가 많고 체인 화면에서 고른다)은 넣지 않는다.
 */

export type SearchKind = "stock" | "future" | "reference";

export interface SearchEntry {
  kind: SearchKind;
  code: string;
  /** 한국어 원래 이름 */
  name: string;
  href: string;
  /** 비교용: 코드·세 언어 이름을 정규화한 값 */
  keys: string[];
  /** 한국어 이름의 초성 */
  initials: string;
}

const CHOSUNG = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ";

function normalize(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/[\s/·・]+/g, "");
}

function initialsOf(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.charCodeAt(0) - 0xac00;
    if (code >= 0 && code < 11172) out += CHOSUNG[Math.floor(code / 588)];
    else if (!/\s/.test(ch)) out += ch.toLowerCase();
  }
  return out;
}

function entry(kind: SearchKind, code: string, name: string, href: string, names: (locale: Locale) => string): SearchEntry {
  const keys = [code, ...LOCALES.map(names)].map(normalize);
  return { kind, code, name, href, keys: [...new Set(keys)], initials: initialsOf(name) };
}

export const SEARCH_ENTRIES: readonly SearchEntry[] = [
  ...SYMBOLS.map((s) =>
    entry("stock", s.symbol, s.name, `/symbol/${s.symbol}`, (l) => localizedSymbolName(s.symbol, s.name, l)),
  ),
  ...FUTURES.map((f) =>
    entry("future", f.symbol, f.name, `/futures/${f.symbol}`, (l) => localizedFutureName(f.symbol, f.name, l)),
  ),
  ...REFERENCE_ASSETS.map((r) =>
    entry("reference", r.code, r.name, `/reference/${r.code}`, (l) => localizedReferenceName(r.code, r.name, l)),
  ),
];

const ONLY_CHOSUNG = /^[ㄱ-ㅎ]+$/;

/** 낮을수록 앞. 일치하지 않으면 null. */
function score(item: SearchEntry, q: string, chosung: string | null): number | null {
  const code = item.keys[0];
  if (code === q) return 0;
  if (code.startsWith(q)) return 1;
  if (item.keys.some((k) => k.startsWith(q))) return 2;
  if (item.keys.some((k) => k.includes(q))) return 3;
  if (chosung) {
    if (item.initials.startsWith(chosung)) return 4;
    if (item.initials.includes(chosung)) return 5;
  }
  return null;
}

export function searchSymbols(query: string, entries: readonly SearchEntry[] = SEARCH_ENTRIES, limit = 8): SearchEntry[] {
  const q = normalize(query);
  if (!q) return [];
  // NFKC는 호환 자모(ㄷ)를 조합형 자모로 바꾸므로 초성은 정규화 전 입력으로 본다.
  const raw = query.replace(/\s+/g, "");
  const chosung = ONLY_CHOSUNG.test(raw) ? raw : null;
  return entries
    .map((item, order) => ({ item, order, rank: score(item, q, chosung) }))
    .filter((r): r is { item: SearchEntry; order: number; rank: number } => r.rank != null)
    .sort((a, b) => a.rank - b.rank || a.order - b.order)
    .slice(0, limit)
    .map((r) => r.item);
}

const STOCK_ENTRIES = SEARCH_ENTRIES.filter((e) => e.kind === "stock");

/** 증권 화면 현물 목록 거르기 — 검색어에 맞는 현물 종목 코드. 검색어가 비어 있으면 null(거르지 않음). */
export function matchStockCodes(query: string): Set<string> | null {
  if (!normalize(query)) return null;
  return new Set(searchSymbols(query, STOCK_ENTRIES, STOCK_ENTRIES.length).map((e) => e.code));
}
