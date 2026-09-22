import type { MacroChannel, SectorTag } from "./types";

/**
 * Story figures have to scale with company size, and size is not the same
 * thing as share price. It happens to rank the same way for these five
 * listings, but stating the implied market cap explicitly keeps a future
 * low-priced large-cap from producing absurd numbers.
 */
export interface CompanyProfile {
  readonly symbol: string;
  readonly sector: SectorTag;
  /** Implied market capitalisation in 억원. */
  readonly capEok: number;
  /**
   * Signed sensitivity to an *increase* in each macro variable — rates rising,
   * won/dollar rising (a weaker won), crude rising, global risk appetite
   * rising. Combined with a story's `macroDirection`, the sign decides whether
   * that story reads as good or bad news for this particular company, which is
   * what makes one FX headline split the market the way a real one does.
   */
  readonly macroBeta: Readonly<Record<MacroChannel, number>>;
  /** Sites this company can plausibly name in a story. */
  readonly plants: readonly string[];
}

export const COMPANY_PROFILES: readonly CompanyProfile[] = [
  {
    symbol: "SAKU",
    sector: "HEAVY",
    capEok: 120_000,
    // Exporter: a weak won lifts order economics, crude is an input cost.
    // Steel plate is the biggest input, so dearer raw materials squeeze the yard.
    macroBeta: { RATE: -0.7, FX: 1.1, OIL: -0.6, COMMODITY: -0.55, GLOBAL: 1.0 },
    plants: ["거제", "울산", "군산"],
  },
  {
    symbol: "KABU",
    sector: "BROKER",
    capEok: 48_000,
    // A brokerage lives on rates and on foreign money staying in the market,
    // so a spiking won/dollar rate is bad news here while it is good for
    // the exporters. This sign flip is the point of the macro betas.
    macroBeta: { RATE: -1.3, FX: -0.9, OIL: 0.35, COMMODITY: 0.2, GLOBAL: 1.2 },
    plants: ["여의도", "판교"],
  },
  {
    symbol: "MOCK",
    sector: "ELECTRONICS",
    capEok: 20_000,
    macroBeta: { RATE: -0.8, FX: 0.9, OIL: -0.3, COMMODITY: -0.4, GLOBAL: 1.25 },
    plants: ["평택", "구미", "천안"],
  },
  {
    symbol: "NEKO",
    sector: "MATERIALS",
    capEok: 9_000,
    // Sells materials on commodity-linked prices, so firm metals lift its ASP.
    macroBeta: { RATE: -0.85, FX: 0.5, OIL: -0.7, COMMODITY: 0.5, GLOBAL: 0.9 },
    plants: ["여수", "대산", "울산"],
  },
  {
    symbol: "TANU",
    sector: "TRADING",
    capEok: 3_000,
    // A commodity trader earns on volatility and carry, so firm crude helps.
    macroBeta: { RATE: -0.6, FX: 0.6, OIL: 0.8, COMMODITY: 0.95, GLOBAL: 0.8 },
    plants: ["부산", "인천", "광양"],
  },
];

const PROFILES_BY_SYMBOL = new Map(COMPANY_PROFILES.map((profile) => [profile.symbol, profile]));

export function companyProfile(symbol: string): CompanyProfile | null {
  return PROFILES_BY_SYMBOL.get(symbol) ?? null;
}

/** Below this the macro story is not worth a separate print for that symbol. */
export const MIN_MACRO_BETA = 0.15;
