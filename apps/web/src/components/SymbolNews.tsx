"use client";

import type { NewsItemDto } from "@mock-kabu/shared";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { mergeNews, parseNewsItem } from "@/lib/news";
import { subscribe } from "@/lib/socket";
import { everyVisible } from "@/lib/visible-interval";
import { NewsList } from "./NewsFeed";

/**
 * This symbol's stories. The API also returns market-wide news here, and the
 * server publishes those to every symbol channel, so one subscription covers
 * everything that moved this price.
 */
export default function SymbolNews({ symbol }: { symbol: string }) {
  const [items, setItems] = useState<NewsItemDto[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setItems([]);
    setLoading(true);

    api<NewsItemDto[]>(`/market/news?symbol=${symbol}&limit=30`, { auth: false })
      .then((rows) => {
        if (active) setItems((previous) => mergeNews(previous, rows));
      })
      .catch(() => {})
      .finally(() => {
        if (active) setLoading(false);
      });

    const unsubscribe = subscribe([`news:${symbol}`], ({ data }) => {
      const item = parseNewsItem(data);
      if (item) setItems((previous) => mergeNews([item], previous));
    });

    const fallback = everyVisible(() => {
      api<NewsItemDto[]>(`/market/news?symbol=${symbol}&limit=30`, { auth: false })
        .then((rows) => setItems((previous) => mergeNews(previous, rows)))
        .catch(() => {});
    }, 15_000);

    return () => {
      active = false;
      unsubscribe();
      fallback();
    };
  }, [symbol]);

  return (
    <section className="glass overflow-hidden">
      <div className="panel-head">
        <span className="panel-title">뉴스</span>
        <span className="chip chip-live">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-ok" />
          LIVE
        </span>
      </div>

      <div className="max-h-96 overflow-y-auto">
        <NewsList
          items={items}
          showSymbol={false}
          loading={loading}
          emptyLabel="이 종목의 뉴스가 아직 없습니다"
        />
      </div>
    </section>
  );
}
