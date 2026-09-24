/**
 * 재상장 시 시가총액 가중 지수 구간을 다시 짜는 순수 계산.
 *
 * - 기존 구간에서 재상장 종목을 빼고, 첫 구간의 제수를 나머지 종목의 상장 시가총액으로 다시
 *   정한다 → 옛 종목의 가격이 과거 지수에 전혀 반영되지 않는다(상장 시 지수 = baseLevel 유지).
 * - 재상장 시각에는 그 순간의 지수 수준이 이어지도록 새 구간의 제수를 정한다(연속성).
 *
 * 과거 편입 변경 구간이 이미 있으면 그 시점의 가격이 없어 다시 계산할 수 없으므로 거부한다.
 */
import { continuingDivisor, indexLevel, type IndexEpoch } from "@mock-kabu/shared";

export interface RelistPlanInput {
  symbol: string;
  listPrice: number;
  baseLevel: number;
  epochs: IndexEpoch[];
  initialPrices: ReadonlyMap<string, number>;
  lastPrices: ReadonlyMap<string, number>;
  shares: ReadonlyMap<string, number>;
  relistAt: number;
}

export interface RelistPlan {
  /** 기존 구간을 대체할 구간들 (재상장 종목 제외). */
  history: IndexEpoch[];
  /** 재상장 시각부터 적용할 구간. */
  next: IndexEpoch;
  /** 재상장 직전(= 직후) 지수 수준. */
  level: number;
}

export function planRelistIndex(input: RelistPlanInput): RelistPlan {
  const { symbol, epochs, shares } = input;
  if (epochs.length !== 1) {
    throw new Error(`index has ${epochs.length} epochs; only a single initial epoch can be rewritten safely`);
  }
  if (!(input.listPrice > 0)) throw new Error("list price must be positive");
  const sharesOf = (s: string) => {
    const value = shares.get(s);
    if (!value || value <= 0) throw new Error(`missing listed shares for ${s}`);
    return value;
  };
  const priceFrom = (prices: ReadonlyMap<string, number>) => (s: string) => {
    const value = prices.get(s);
    if (!value || value <= 0) throw new Error(`missing price for ${s}`);
    return value;
  };

  const [initial] = epochs;
  if (input.relistAt <= initial.startsAt) throw new Error("relist time must be after the initial epoch");
  const others = initial.members.filter((member) => member !== symbol).sort();
  if (others.length === 0) throw new Error("the index would have no members before the relisting");

  const initialCap = others.reduce((sum, s) => sum + priceFrom(input.initialPrices)(s) * sharesOf(s), 0);
  const history: IndexEpoch = { startsAt: initial.startsAt, divisor: initialCap / input.baseLevel, members: others };
  const level = indexLevel(history, priceFrom(input.lastPrices), sharesOf);

  const members = [...others, symbol].sort();
  const capAfter = others.reduce((sum, s) => sum + priceFrom(input.lastPrices)(s) * sharesOf(s), 0) + input.listPrice * sharesOf(symbol);
  const next: IndexEpoch = { startsAt: input.relistAt, divisor: continuingDivisor(capAfter, level), members };
  return { history: [history], next, level };
}

export interface AddMembersInput {
  /** 지금 적용 중인 구간 (가장 최근). */
  current: IndexEpoch;
  /** 새로 편입할 종목 — 편입 순간 가격은 상장가. */
  newSymbols: readonly string[];
  lastPrices: ReadonlyMap<string, number>;
  shares: ReadonlyMap<string, number>;
  at: number;
}

/**
 * 신규 상장 종목을 지수에 넣는 새 구간. 편입 직전 수준이 그대로 이어지도록 제수를 정하므로
 * 편입 자체로는 지수가 움직이지 않고, 이후 신규 종목의 가격 변화가 시가총액 비중만큼 반영된다.
 */
export function planAddIndexMembers(input: AddMembersInput): { next: IndexEpoch; level: number } {
  const { current, newSymbols, shares, lastPrices } = input;
  if (newSymbols.length === 0) throw new Error("nothing to add");
  if (input.at <= current.startsAt) throw new Error("new epoch must start after the current one");
  const duplicate = newSymbols.find((s) => current.members.includes(s));
  if (duplicate) throw new Error(`${duplicate} is already an index member`);
  const need = (map: ReadonlyMap<string, number>, s: string, what: string) => {
    const value = map.get(s);
    if (!value || value <= 0) throw new Error(`missing ${what} for ${s}`);
    return value;
  };
  const priceOf = (s: string) => need(lastPrices, s, "price");
  const sharesOf = (s: string) => need(shares, s, "listed shares");
  const level = indexLevel(current, priceOf, sharesOf);
  const members = [...current.members, ...newSymbols].sort();
  const capAfter = members.reduce((sum, s) => sum + priceOf(s) * sharesOf(s), 0);
  return { next: { startsAt: input.at, divisor: continuingDivisor(capAfter, level), members }, level };
}
