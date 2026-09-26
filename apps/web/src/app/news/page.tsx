"use client";

import { INDUSTRIES, industryById, industryOf, NEWS_FEED_SCOPE, SYMBOLS, type NewsItemDto } from "@mock-kabu/shared";
import { useEffect, useMemo, useState } from "react";
import ChipTabs, { type ChipTabItem } from "@/components/ChipTabs";
import { NewsList } from "@/components/NewsFeed";
import { api } from "@/lib/api";
import { mergeNews, parseNewsItem } from "@/lib/news";
import { MARKET_TIME_ZONE_LABEL } from "@/lib/time";
import { subscribe } from "@/lib/socket";
import { readQueryParam, writeQueryParams } from "@/lib/url-query";
import { everyVisible } from "@/lib/visible-interval";
import { useNames, useT } from "@/lib/i18n";

/**
 * 뉴스 — 종목이 15개로 늘어 종목 칩 한 줄이 길어졌으므로 산업군으로 먼저 고르고, 고른 산업군
 * 안에서만 종목을 좁힌다. 산업군·시장 전반은 서버에서 따로 읽어 오래된 기사도 60건까지 보인다.
 */

const ALL = "all";
const MARKET = "market";
const SYMBOL_ALL = "*";

type Scope = string; // ALL | MARKET | industry id

const SCOPE_ITEMS: ChipTabItem[] = [
  { id: ALL, label: "전체" },
  { id: MARKET, label: "시장 전반" },
  ...INDUSTRIES.map((industry) => ({ id: industry.id, label: industry.label })),
];
const SYMBOL_NAMES = new Map(SYMBOLS.map((symbol) => [symbol.symbol, symbol.name]));

function feedUrl(scope: Scope): string {
  return scope === ALL ? "/market/news?limit=60" : `/market/news?industry=${scope}&limit=60`;
}

function inScope(item: NewsItemDto, scope: Scope): boolean {
  if (scope === ALL) return true;
  if (scope === MARKET) return item.symbol === null && !item.industry;
  if (item.industry) return item.industry === scope;
  return item.symbol !== null && industryOf(item.symbol)?.id === scope;
}

function validScope(value: string | null): Scope {
  return value === MARKET || (value && industryById(value)) ? value : ALL;
}

export default function NewsPage() {
  const t = useT();
  const names = useNames();
  const [scope, setScope] = useState<Scope>(ALL);
  const [symbol, setSymbol] = useState<string>(SYMBOL_ALL);
  const [items, setItems] = useState<NewsItemDto[]>([]);
  const [loading, setLoading] = useState(true);

  // 주소의 ?industry=&symbol=을 첫 화면에 반영한다.
  useEffect(() => {
    const initial = validScope(readQueryParam("industry"));
    setScope(initial);
    const wanted = readQueryParam("symbol");
    if (wanted && industryById(initial)?.symbols.includes(wanted)) setSymbol(wanted);
  }, []);

  // The feed is public, so unlike the account pages this one needs no session.
  useEffect(() => {
    let active = true;
    setItems([]);
    setLoading(true);

    const load = () =>
      api<NewsItemDto[]>(feedUrl(scope), { auth: false })
        .then((rows) => {
          if (active) setItems((previous) => mergeNews(previous, rows));
        })
        .catch(() => {})
        .finally(() => {
          if (active) setLoading(false);
        });
    load();

    // One firehose channel carries every story, symbol-scoped or market-wide.
    const unsubscribe = subscribe([`news:${NEWS_FEED_SCOPE}`], ({ data }) => {
      const item = parseNewsItem(data);
      if (item && inScope(item, scope)) setItems((previous) => mergeNews([item], previous));
    });

    // WebSocket push is the main path; this backstops a missed reconnect.
    const fallback = everyVisible(load, 15_000);

    return () => {
      active = false;
      unsubscribe();
      fallback();
    };
  }, [scope]);

  const industry = industryById(scope);

  function chooseScope(next: Scope) {
    setScope(next);
    setSymbol(SYMBOL_ALL);
    writeQueryParams({ industry: next === ALL ? null : next, symbol: null });
  }

  function chooseSymbol(next: string) {
    setSymbol(next);
    writeQueryParams({ symbol: next === SYMBOL_ALL ? null : next });
  }

  const symbolItems = useMemo<ChipTabItem[]>(
    () =>
      industry && industry.symbols.length > 1
        ? [
            { id: SYMBOL_ALL, label: t("{name} 전체", { name: names.industry(industry.id, industry.label) }) },
            ...industry.symbols.map((code) => ({ id: code, label: names.symbol(code, SYMBOL_NAMES.get(code) ?? code) })),
          ]
        : [],
    [industry, t, names],
  );

  const visible = useMemo(
    () => (symbol === SYMBOL_ALL ? items : items.filter((item) => item.symbol === symbol)),
    [items, symbol],
  );

  const title =
    symbol !== SYMBOL_ALL
      ? names.symbol(symbol, SYMBOL_NAMES.get(symbol) ?? symbol)
      : scope === ALL
        ? t("전체 뉴스")
        : scope === MARKET
          ? t("시장 전반")
          : industry
            ? names.industry(industry.id, industry.label)
            : t("뉴스");
  const members = industry
    ? industry.symbols.map((code) => names.symbol(code, SYMBOL_NAMES.get(code) ?? code)).join(" · ")
    : null;
  const scopeItems = useMemo<ChipTabItem[]>(
    () => SCOPE_ITEMS.map((item) => ({ ...item, label: industryById(item.id) ? names.industry(item.id, item.label) : t(item.label) })),
    [t, names],
  );

  return (
    <div className="mx-auto max-w-3xl space-y-4 sm:space-y-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">{t("뉴스")}</h1>
        <p className="mt-1 text-sm text-ink-muted">
          {t("모의 시장에서 발생하는 종목·시장 소식입니다. 각 종목의 수급은 뉴스에 반응합니다.")}
        </p>
      </div>

      <div className="space-y-2">
        <ChipTabs label={t("산업군")} items={scopeItems} value={scope} onChange={chooseScope} />
        {symbolItems.length > 0 && (
          <ChipTabs label={t("종목")} size="sm" items={symbolItems} value={symbol} onChange={chooseSymbol} />
        )}
      </div>

      <section className="glass overflow-hidden">
        <div className="panel-head">
          <span className="min-w-0">
            <span className="panel-title block">{title}</span>
            {members && symbol === SYMBOL_ALL && (
              <span className="mt-0.5 block truncate text-[11px] text-ink-faint">{members}</span>
            )}
          </span>
          <span className="chip chip-live">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-ok" />
            LIVE
          </span>
        </div>

        <NewsList
          items={visible}
          loading={loading}
          showSymbol={symbol === SYMBOL_ALL && scope !== MARKET}
          showIndustry={scope === ALL}
          emptyLabel={
            symbol !== SYMBOL_ALL
              ? t("이 종목의 뉴스가 아직 없습니다")
              : scope === ALL
                ? t("아직 뉴스가 없습니다")
                : t("이 분야의 뉴스가 아직 없습니다")
          }
        />
      </section>

      <p className="text-[11px] text-ink-faint">{t("시각은 {tz} 기준입니다.", { tz: MARKET_TIME_ZONE_LABEL })}</p>
    </div>
  );
}
