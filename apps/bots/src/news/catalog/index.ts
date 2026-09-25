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

/** Industry stories. */
export const SECTOR_POOL = NEWS_TEMPLATES.filter((template) => template.scope === "SECTOR");

/** Market-wide stories. */
export const MACRO_POOL = NEWS_TEMPLATES.filter((template) => template.scope === "MACRO");

/** Reachable only through a parent story's followUp. */
export const SEQUEL_POOL = NEWS_TEMPLATES.filter((template) => template.sequelOnly === true);

export function templateById(id: string): NewsTemplate | null {
  return TEMPLATES_BY_ID.get(id) ?? null;
}
