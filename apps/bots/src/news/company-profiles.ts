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
  {
    symbol: "BORI",
    sector: "FOOD",
    capEok: 6_000,
    // Imports grain and sugar in dollars: a weak won and firm commodities squeeze margins.
    macroBeta: { RATE: -0.4, FX: -0.5, OIL: -0.4, COMMODITY: -0.6, GLOBAL: 0.3 },
    plants: ["이천", "음성", "김해"],
  },
  {
    symbol: "BJAY",
    sector: "AIRLINE",
    capEok: 15_000,
    // Jet fuel and aircraft leases are paid in dollars, so crude and a weak won both hurt.
    macroBeta: { RATE: -0.6, FX: -1.0, OIL: -1.3, COMMODITY: -0.2, GLOBAL: 1.0 },
    plants: ["인천공항", "김포", "제주"],
  },
  {
    symbol: "SKYL",
    sector: "TELECOM",
    capEok: 30_000,
    // A defensive, debt-funded network operator: rates matter, the cycle much less.
    macroBeta: { RATE: -0.9, FX: -0.2, OIL: -0.1, COMMODITY: -0.1, GLOBAL: 0.4 },
    plants: ["판교", "대전", "광주"],
  },
  {
    symbol: "PIXL",
    sector: "GAME",
    capEok: 20_000,
    // Growth stock with overseas revenue: rate cuts and a weak won both help.
    macroBeta: { RATE: -1.0, FX: 0.6, OIL: 0, COMMODITY: 0, GLOBAL: 1.1 },
    plants: ["판교", "성수"],
  },
  {
    symbol: "DAON",
    sector: "SEMICONDUCTOR",
    capEok: 90_000,
    // Chip exporter riding the global cycle.
    macroBeta: { RATE: -0.8, FX: 1.0, OIL: -0.3, COMMODITY: -0.4, GLOBAL: 1.4 },
    plants: ["평택", "청주", "용인"],
  },
  {
    symbol: "DDAM",
    sector: "CONSTRUCTION",
    capEok: 12_000,
    // Housing and civil works: rates drive presales, and cement/steel are input costs.
    macroBeta: { RATE: -1.4, FX: -0.2, OIL: -0.4, COMMODITY: -0.7, GLOBAL: 0.5 },
    plants: ["세종", "송도", "평택 고덕"],
  },
  {
    symbol: "SAEM",
    sector: "BIO",
    capEok: 12_000,
    // Long-duration pipeline valued on discount rates; macro cycle barely matters.
    macroBeta: { RATE: -1.2, FX: 0.3, OIL: 0, COMMODITY: 0, GLOBAL: 0.6 },
    plants: ["오송", "송도", "대구 첨복단지"],
  },
  {
    symbol: "STEL",
    sector: "ENTERTAINMENT",
    capEok: 12_000,
    // Music and touring earn overseas, so a weak won helps; a growth multiple hates rates.
    macroBeta: { RATE: -1.0, FX: 0.7, OIL: -0.1, COMMODITY: 0, GLOBAL: 0.9 },
    plants: ["성수", "청담", "일산"],
  },
  {
    symbol: "SLVR",
    sector: "AUTO",
    capEok: 12_000,
    // Big exporter with car loans at home: a weak won helps, rates and steel hurt.
    macroBeta: { RATE: -0.8, FX: 1.2, OIL: -0.5, COMMODITY: -0.5, GLOBAL: 1.2 },
    plants: ["아산", "광주", "울산"],
  },
  {
    symbol: "NOVA",
    sector: "BATTERY",
    capEok: 12_000,
    // Cell maker: lithium and nickel are the input cost, EV demand rides the global cycle.
    macroBeta: { RATE: -1.1, FX: 0.8, OIL: 0.2, COMMODITY: -0.9, GLOBAL: 1.3 },
    plants: ["오창", "청주", "새만금"],
  },
];

const PROFILES_BY_SYMBOL = new Map(COMPANY_PROFILES.map((profile) => [profile.symbol, profile]));

export function companyProfile(symbol: string): CompanyProfile | null {
  return PROFILES_BY_SYMBOL.get(symbol) ?? null;
}

/** Below this the macro story is not worth a separate print for that symbol. */
export const MIN_MACRO_BETA = 0.15;
