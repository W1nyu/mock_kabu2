import { SYMBOLS } from "./constants";

/**
 * 화면에서 종목을 묶어 보는 산업군. 뉴스 생성용 세부 섹터(봇의 SectorTag)보다 굵게 묶어,
 * 종목이 늘어도 칩 한 줄로 고를 수 있게 한다. 모든 상장 종목은 정확히 한 산업군에 속한다.
 */
export interface IndustryDef {
  id: string;
  label: string;
  symbols: readonly string[];
}

export const INDUSTRIES: readonly IndustryDef[] = [
  { id: "tech", label: "IT·반도체", symbols: ["DAON"] },
  { id: "battery", label: "2차전지·소재", symbols: ["NOVA", "NEKO"] },
  { id: "industrial", label: "산업재", symbols: ["SAKU", "DDAM"] },
  { id: "mobility", label: "모빌리티", symbols: ["SLVR", "BJAY"] },
  { id: "media", label: "미디어·통신", symbols: ["STEL", "SKYL"] },
  { id: "health", label: "헬스케어", symbols: ["SAEM"] },
  { id: "energy", label: "에너지·유틸리티", symbols: ["NRFD", "GARM"] },
  { id: "consumer", label: "소비재", symbols: ["BORI"] },
  { id: "finance", label: "금융·부동산", symbols: ["KABU", "HAVN"] },
];

const INDUSTRY_BY_SYMBOL = new Map(
  INDUSTRIES.flatMap((industry) => industry.symbols.map((symbol) => [symbol, industry] as const)),
);
const INDUSTRY_BY_ID = new Map(INDUSTRIES.map((industry) => [industry.id, industry]));

export function industryOf(symbol: string): IndustryDef | null {
  return INDUSTRY_BY_SYMBOL.get(symbol) ?? null;
}

export function industryById(id: string): IndustryDef | null {
  return INDUSTRY_BY_ID.get(id) ?? null;
}

/** 상장 종목과 산업군 정의가 어긋나면 이유를 돌려준다(없으면 null). 테스트가 쓴다. */
export function industryCoverageProblem(): string | null {
  const listed = new Set(SYMBOLS.map((symbol) => symbol.symbol));
  const seen = new Set<string>();
  for (const industry of INDUSTRIES) {
    for (const symbol of industry.symbols) {
      if (!listed.has(symbol)) return `${industry.id} lists unknown symbol ${symbol}`;
      if (seen.has(symbol)) return `${symbol} belongs to more than one industry`;
      seen.add(symbol);
    }
  }
  const missing = [...listed].filter((symbol) => !seen.has(symbol));
  return missing.length > 0 ? `no industry for ${missing.join(", ")}` : null;
}
