"use client";

import { NEWS_FEED_SCOPE, type NewsItemDto } from "@mock-kabu/shared";
import { useEffect, useMemo, useState } from "react";
import { NewsList } from "@/components/NewsFeed";
import { api } from "@/lib/api";
import { mergeNews, parseNewsItem } from "@/lib/news";
import { MARKET_TIME_ZONE_LABEL } from "@/lib/time";
import { subscribe } from "@/lib/socket";

interface SymbolRow {
  symbol: string;
  name: string;
}

export default function NewsPage() {
  const [items, setItems] = useState<NewsItemDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [symbols, setSymbols] = useState<SymbolRow[]>([]);
  const [filter, setFilter] = useState<string | null>(null);

  // The feed is public, so unlike the account pages this one needs no session.
  useEffect(() => {
    let active = true;

    api<NewsItemDto[]>("/market/news?limit=60", { auth: false })
      .then((rows) => {
        if (!active) return;
        setItems((previous) => mergeNews(previous, rows));
      })
      .catch(() => {})
      .finally(() => {
        if (active) setLoading(false);
      });

    api<SymbolRow[]>("/market/symbols", { auth: false })
      .then((rows) => {
        if (active) setSymbols(rows);
      })
      .catch(() => {});

    // One firehose channel carries every story, symbol-scoped or market-wide.
    const unsubscribe = subscribe([`news:${NEWS_FEED_SCOPE}`], ({ data }) => {
      const item = parseNewsItem(data);
      if (item) setItems((previous) => mergeNews([item], previous));
    });

    // WebSocket push is the main path; this backstops a missed reconnect.
    const fallback = window.setInterval(() => {
      api<NewsItemDto[]>("/market/news?limit=60", { auth: false })
        .then((rows) => setItems((previous) => mergeNews(previous, rows)))
        .catch(() => {});
    }, 15_000);

    return () => {
      active = false;
      unsubscribe();
      window.clearInterval(fallback);
    };
  }, []);

  const visible = useMemo(
    () => (filter === null ? items : items.filter((item) => item.symbol === filter)),
    [filter, items],
  );

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">뉴스</h1>
        <p className="mt-1 text-sm text-ink-muted">
          모의 시장에서 발생하는 종목·시장 소식입니다. 각 종목의 수급은 뉴스에 반응합니다.
        </p>
      </div>

      <div className="flex flex-wrap gap-1.5">
        <FilterChip label="전체" active={filter === null} onClick={() => setFilter(null)} />
        {symbols.map((row) => (
          <FilterChip
            key={row.symbol}
            label={row.name}
            active={filter === row.symbol}
            onClick={() => setFilter(row.symbol)}
          />
        ))}
      </div>

      <section className="glass overflow-hidden">
        <div className="panel-head">
          <span className="panel-title">
            {filter === null ? "전체 뉴스" : (symbols.find((s) => s.symbol === filter)?.name ?? filter)}
          </span>
          <span className="chip chip-live">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-ok" />
            LIVE
          </span>
        </div>

        <NewsList
          items={visible}
          loading={loading}
          emptyLabel={
            filter === null ? "아직 뉴스가 없습니다" : "이 종목의 뉴스가 아직 없습니다"
          }
        />
      </section>

      <p className="text-[11px] text-ink-faint">시각은 {MARKET_TIME_ZONE_LABEL} 기준입니다.</p>
    </div>
  );
}

function FilterChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-full px-3.5 py-1.5 text-[13px] font-medium transition-colors ${
        active
          ? "bg-sky/12 text-sky ring-1 ring-inset ring-sky/30"
          : "text-ink-muted hover:bg-surface-3/45 hover:text-ink"
      }`}
    >
      {label}
    </button>
  );
}
