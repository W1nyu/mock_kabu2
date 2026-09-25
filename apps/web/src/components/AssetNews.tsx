"use client";

import { NEWS_FEED_SCOPE, type NewsItemDto } from "@mock-kabu/shared";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { mergeNews, parseNewsItem } from "@/lib/news";
import { subscribe } from "@/lib/socket";
import { everyVisible } from "@/lib/visible-interval";
import { NewsList } from "./NewsFeed";

/**
 * 선물·원자재·환율 화면의 관련 뉴스.
 *  - reference 코드(USDKRW·OIL·GAS·COPPER·GOLD·CORN)면 그 기초자산을 움직인 기사
 *  - "market"이면 시장 전반 기사(주가지수 선물)
 * 실시간은 전체 뉴스 피드를 받아 해당하는 기사만 붙이고, 15초마다(보일 때) 다시 읽어 빈틈을 메운다.
 */
export default function AssetNews({ reference, title = "관련 뉴스" }: { reference: string | "market"; title?: string }) {
  const [items, setItems] = useState<NewsItemDto[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setItems([]);
    setLoading(true);
    const url =
      reference === "market" ? "/market/news?industry=market&limit=30" : `/market/news?reference=${reference}&limit=30`;
    const matches = (item: NewsItemDto) =>
      reference === "market"
        ? item.symbol == null && item.industry == null
        : (item.referenceCodes ?? []).includes(reference);

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

    const unsubscribe = subscribe([`news:${NEWS_FEED_SCOPE}`], ({ data }) => {
      const item = parseNewsItem(data);
      if (item && matches(item)) setItems((previous) => mergeNews([item], previous));
    });
    const fallback = everyVisible(load, 15_000);
    return () => {
      active = false;
      unsubscribe();
      fallback();
    };
  }, [reference]);

  return (
    <section className="glass overflow-hidden">
      <div className="panel-head">
        <span className="panel-title">{title}</span>
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
          emptyLabel={reference === "market" ? "시장 전반 뉴스가 아직 없습니다" : "이 자산을 다룬 뉴스가 아직 없습니다"}
        />
      </div>
    </section>
  );
}
