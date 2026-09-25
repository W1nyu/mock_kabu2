"use client";

import { industryOf, type NewsItemDto } from "@mock-kabu/shared";
import { useEffect, useMemo, useState } from "react";
import ChipTabs from "@/components/ChipTabs";
import { api } from "@/lib/api";
import { mergeNews, parseNewsItem } from "@/lib/news";
import { subscribe } from "@/lib/socket";
import { everyVisible } from "@/lib/visible-interval";
import { NewsList } from "./NewsFeed";

type Scope = "all" | "own" | "industry" | "market";
const SCOPE_STORAGE_KEY = "symbol:news-scope";

/**
 * 종목 화면의 뉴스. 탭으로 범위를 고른다:
 *  - 전체: 이 종목 기사 + 같은 산업군 기사 + 시장 전반 기사(가격을 움직인 모든 뉴스)
 *  - 이 종목: 이 종목을 직접 다룬 기사만
 *  - 업종: 같은 산업군의 종목 기사와 산업군 기사
 *  - 시장 전반: 환율·금리·유가 같은 시장 전체 기사
 * 실시간은 종목 채널(이 종목·산업군·시장 기사)을 받고 탭에 맞는 것만 붙인다. 업종 탭의 다른 종목 기사는 15초 폴링으로 채운다.
 */
export default function SymbolNews({ symbol }: { symbol: string }) {
  const industry = industryOf(symbol);
  const [scope, setScope] = useState<Scope>("all");
  const [items, setItems] = useState<NewsItemDto[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(SCOPE_STORAGE_KEY);
      if (saved === "all" || saved === "own" || saved === "industry" || saved === "market") setScope(saved);
    } catch {
      // ignore
    }
  }, []);

  function chooseScope(next: string) {
    const value = next as Scope;
    setScope(value);
    try {
      window.localStorage.setItem(SCOPE_STORAGE_KEY, value);
    } catch {
      // ignore
    }
  }

  const tabs = useMemo(
    () => [
      { id: "all", label: "전체" },
      { id: "own", label: "이 종목" },
      ...(industry ? [{ id: "industry", label: industry.label }] : []),
      { id: "market", label: "시장 전반" },
    ],
    [industry],
  );
  const effectiveScope: Scope = scope === "industry" && !industry ? "all" : scope;

  useEffect(() => {
    let active = true;
    setItems([]);
    setLoading(true);

    const url =
      effectiveScope === "own"
        ? `/market/news?symbol=${symbol}&scope=own&limit=30`
        : effectiveScope === "industry" && industry
          ? `/market/news?industry=${industry.id}&limit=30`
          : effectiveScope === "market"
            ? `/market/news?industry=market&limit=30`
            : `/market/news?symbol=${symbol}&limit=30`;
    const matches = (item: NewsItemDto) =>
      effectiveScope === "own"
        ? item.symbol === symbol
        : effectiveScope === "industry"
          ? item.industry === industry?.id || (item.symbol != null && industry?.symbols.includes(item.symbol) === true)
          : effectiveScope === "market"
            ? item.symbol == null && item.industry == null
            : true;

    const load = () =>
      api<NewsItemDto[]>(url, { auth: false })
        .then((rows) => {
          if (active) setItems((previous) => mergeNews(previous, rows));
        })
        .catch(() => {})
        .finally(() => {
          if (active) setLoading(false);
        });
    void load();

    const unsubscribe = subscribe([`news:${symbol}`], ({ data }) => {
      const item = parseNewsItem(data);
      if (item && matches(item)) setItems((previous) => mergeNews([item], previous));
    });
    const fallback = everyVisible(load, 15_000);

    return () => {
      active = false;
      unsubscribe();
      fallback();
    };
  }, [symbol, effectiveScope, industry]);

  const emptyLabel =
    effectiveScope === "own"
      ? "이 종목을 다룬 뉴스가 아직 없습니다"
      : effectiveScope === "industry"
        ? `${industry?.label ?? "업종"} 뉴스가 아직 없습니다`
        : effectiveScope === "market"
          ? "시장 전반 뉴스가 아직 없습니다"
          : "이 종목의 뉴스가 아직 없습니다";

  return (
    <section className="glass overflow-hidden">
      <div className="panel-head">
        <span className="panel-title">뉴스</span>
        <span className="chip chip-live">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-ok" />
          LIVE
        </span>
      </div>
      <div className="border-b border-hairline-soft px-3 py-2">
        <ChipTabs label="뉴스 범위" size="sm" items={tabs} value={effectiveScope} onChange={chooseScope} />
      </div>

      <div className="max-h-96 overflow-y-auto">
        <NewsList items={items} showSymbol={effectiveScope === "industry"} loading={loading} emptyLabel={emptyLabel} />
      </div>
    </section>
  );
}
