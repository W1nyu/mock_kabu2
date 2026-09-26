import { INDUSTRIES, localizedIndustryLabel } from "@mock-kabu/shared";
import { getLocale, translate } from "@/lib/i18n";
import type { ChipTabItem } from "@/components/ChipTabs";

export const ALL_INDUSTRIES = "all";
export const INDUSTRY_STORAGE_KEY = "market:industry";

/**
 * 산업군 칩 목록. 소속 종목 등락률(%)의 단순 평균을 칩 옆에 붙여 어느 업종이 강한지 한눈에 보이게
 * 한다. 증권 탭(폰)과 대시보드 종목표(PC)가 같은 칩을 쓴다.
 */
export function industryChipItems(changeBySymbol: ReadonlyMap<string, number>): ChipTabItem[] {
  const hint = (symbols: readonly string[]) => {
    const values = symbols.map((symbol) => changeBySymbol.get(symbol)).filter((v): v is number => v !== undefined);
    if (values.length === 0) return undefined;
    const avg = values.reduce((sum, v) => sum + v, 0) / values.length;
    const shown = Math.round(avg * 100) / 100;
    const tone = shown > 0 ? "text-up" : shown < 0 ? "text-down" : "text-ink-muted";
    return (
      <span className={`num text-[11px] ${tone}`}>
        {shown > 0 ? "+" : ""}
        {shown.toFixed(2)}%
      </span>
    );
  };
  const locale = getLocale();
  return [
    { id: ALL_INDUSTRIES, label: translate(locale, "전체") },
    ...INDUSTRIES.map((def) => ({ id: def.id, label: localizedIndustryLabel(def.id, def.label, locale), hint: hint(def.symbols) })),
  ];
}
