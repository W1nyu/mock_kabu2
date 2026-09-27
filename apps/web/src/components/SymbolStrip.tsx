"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { fmt, sharedGet } from "@/lib/api";
import { subscribe } from "@/lib/socket";
import { kstSessionStartMs, onKstSessionOpen } from "@/lib/time";
import { everyVisible } from "@/lib/visible-interval";
import { useNames, useT } from "@/lib/i18n";

interface SymbolRow {
  symbol: string;
  name: string;
  lastPrice: number;
  referencePrice: number;
  sessionStart: number;
}

/**
 * 거래 페이지 상단의 종목 전환 스트립. 다섯 종목의 현재가·등락률을 실시간으로 보여주고
 * 클릭으로 바로 옮겨간다. 현재 종목은 강조하고, 나머지는 같은 소켓 구독으로 갱신한다.
 */
export default function SymbolStrip({ current }: { current: string }) {
  const t = useT();
  const names = useNames();
  const [rows, setRows] = useState<SymbolRow[]>([]);
  const [live, setLive] = useState<Record<string, number>>({});

  useEffect(() => {
    let active = true;
    const load = () => {
      sharedGet<SymbolRow[]>("/market/symbols")
        .then((data) => {
          if (active && data.every((row) => row.sessionStart >= kstSessionStartMs())) setRows(data);
        })
        .catch(() => {});
    };
    load();
    const refreshTimer = everyVisible(load, 30_000);
    const stopSessionRefresh = onKstSessionOpen(load);
    return () => {
      active = false;
      refreshTimer();
      stopSessionRefresh();
    };
  }, []);

  useEffect(() => {
    if (rows.length === 0) return;
    return subscribe(
      rows.map((r) => `trades:${r.symbol}`),
      ({ channel, data }) => {
        const price = Number(data?.price);
        if (!Number.isFinite(price)) return;
        const symbol = channel.slice("trades:".length);
        setLive((prev) => (prev[symbol] === price ? prev : { ...prev, [symbol]: price }));
      },
    );
  }, [rows]);

  if (rows.length === 0) return null;

  return (
    <nav aria-label={t("종목 전환")} className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1">
      {rows.map((r) => {
        const price = live[r.symbol] ?? r.lastPrice;
        const change = r.referencePrice > 0 ? ((price - r.referencePrice) / r.referencePrice) * 100 : 0;
        const tone = change > 0 ? "text-up" : change < 0 ? "text-down" : "text-ink-muted";
        const active = r.symbol === current;
        return (
          <Link
            key={r.symbol}
            href={`/symbol/${r.symbol}`}
            aria-current={active ? "page" : undefined}
            className={`num flex shrink-0 items-baseline gap-2 rounded-[10px] border px-3 py-1.5 text-xs transition-colors ${
              active
                ? "border-sky/40 bg-sky/10 text-ink"
                : "border-hairline-soft bg-surface-2/40 text-ink-muted hover:border-hairline hover:text-ink"
            }`}
          >
            <span className="font-semibold">{names.symbol(r.symbol, r.name)}</span>
            <span className={active ? "text-ink" : ""}>{fmt.format(price)}</span>
            <span className={tone}>
              {change > 0 ? "+" : ""}
              {change.toFixed(2)}%
            </span>
          </Link>
        );
      })}
    </nav>
  );
}
