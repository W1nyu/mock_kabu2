"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { changePct, fmtFuture, type FutureRow } from "@/lib/futures";
import { subscribe } from "@/lib/socket";
import { everyVisible } from "@/lib/visible-interval";
import { useNames, useT } from "@/lib/i18n";

function tone(delta: number | null): string {
  return delta == null ? "text-ink-faint" : delta > 0 ? "text-up" : delta < 0 ? "text-down" : "text-ink-muted";
}

/** 선물 5종 목록 — 이름·티커, 선물가·등락률. 체결은 소켓, 목록은 15초마다 다시 읽는다. */
export default function FuturesList() {
  const t = useT();
  const names = useNames();
  const [rows, setRows] = useState<FutureRow[]>([]);
  const [live, setLive] = useState<Record<string, number>>({});

  useEffect(() => {
    let active = true;
    const load = () =>
      api<FutureRow[]>("/market/futures", { auth: false })
        .then((data) => {
          if (active) setRows(data);
        })
        .catch(() => {});
    load();
    const stop = everyVisible(load, 15_000);
    return () => {
      active = false;
      stop();
    };
  }, []);

  const symbols = rows.map((row) => row.symbol).join(",");
  useEffect(() => {
    if (!symbols) return;
    return subscribe(
      symbols.split(",").map((symbol) => `trades:${symbol}`),
      ({ channel, data }) => {
        const price = Number((data as { price?: unknown })?.price);
        if (!Number.isFinite(price)) return;
        const symbol = channel.slice("trades:".length);
        setLive((prev) => (prev[symbol] === price ? prev : { ...prev, [symbol]: price }));
      },
    );
  }, [symbols]);

  const list = useMemo(
    () => rows.map((row) => {
      const price = live[row.symbol] ?? row.lastPrice;
      return { ...row, price, change: changePct(price, row.base) };
    }),
    [rows, live],
  );

  return (
    <ul className="divide-y divide-hairline-soft">
      {list.map((row) => (
        <li key={row.symbol}>
          <Link
            href={`/futures/${row.symbol}`}
            className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-surface-3/30 active:bg-surface-3/45"
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate font-semibold">{names.future(row.symbol, row.name)}</span>
              <span className="num block truncate text-xs text-ink-faint">
                {row.symbol}
              </span>
            </span>
            <span className="w-[6.5rem] shrink-0 text-right">
              <span className="num block font-semibold">{fmtFuture(row.symbol, row.price)}</span>
              <span className={`num block text-xs font-medium ${tone(row.change)}`}>
                {row.change == null ? "—" : `${row.change > 0 ? "+" : ""}${row.change.toFixed(2)}%`}
              </span>
            </span>
          </Link>
        </li>
      ))}
      {list.length === 0 && <li className="py-8 text-center text-sm text-ink-faint">{t("불러오는 중…")}</li>}
    </ul>
  );
}
