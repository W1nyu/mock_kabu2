import { SYMBOLS } from "@mock-kabu/shared";
import { companyProfile } from "../company-profiles";
import type { NewsTemplate } from "../types";
import { ANALYST_TEMPLATES } from "./analyst";
import { BUSINESS_TEMPLATES } from "./business";
import { CAPITAL_TEMPLATES } from "./capital";
import { EARNINGS_TEMPLATES } from "./earnings";
import { FLOW_TEMPLATES } from "./flow";
import { INDUSTRY_COMPANY_TEMPLATES } from "./industry-company";
import { MACRO_TEMPLATES } from "./macro";
import { MACRO_EXTRA_TEMPLATES } from "./macro-extra";
import { RISK_TEMPLATES } from "./risk";
import { SECTOR_TEMPLATES } from "./sector";
import { SEQUEL_TEMPLATES } from "./sequels";

export const NEWS_TEMPLATES: readonly NewsTemplate[] = [
  ...CAPITAL_TEMPLATES,
  ...EARNINGS_TEMPLATES,
  ...ANALYST_TEMPLATES,
  ...BUSINESS_TEMPLATES,
  ...RISK_TEMPLATES,
  ...FLOW_TEMPLATES,
  ...INDUSTRY_COMPANY_TEMPLATES,
  ...MACRO_TEMPLATES,
  ...MACRO_EXTRA_TEMPLATES,
  ...SECTOR_TEMPLATES,
  ...SEQUEL_TEMPLATES,
];

export const TEMPLATES_BY_ID = new Map(NEWS_TEMPLATES.map((template) => [template.id, template]));

/** Primary picker pool: per-company stories only. */
export const SYMBOL_POOL = NEWS_TEMPLATES.filter(
  (template) => template.scope === "SYMBOL" && !template.sequelOnly,
);

/** 상장 중인 종목의 업종 — 상장 폐지로 종목이 없어진 업종(전자·상사·게임 등)은 빠진다. */
const LISTED_SECTORS = new Set(SYMBOLS.map((symbol) => companyProfile(symbol.symbol)?.sector).filter(Boolean));

/** Industry stories — 주 대상 업종(가중치 1)에 상장 종목이 있는 것만. 없으면 기사가 가리킬 회사가 없다. */
export const SECTOR_POOL = NEWS_TEMPLATES.filter(
  (template) =>
    template.scope === "SECTOR" &&
    Object.entries(template.sectorExposure ?? {}).some(
      ([sector, weight]) => weight === 1 && LISTED_SECTORS.has(sector as never),
    ),
);

/** Market-wide stories. */
export const MACRO_POOL = NEWS_TEMPLATES.filter((template) => template.scope === "MACRO");

/** Reachable only through a parent story's followUp. */
export const SEQUEL_POOL = NEWS_TEMPLATES.filter((template) => template.sequelOnly === true);

export function templateById(id: string): NewsTemplate | null {
  return TEMPLATES_BY_ID.get(id) ?? null;
}
