"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import Sparkline from "@/components/Sparkline";
import { api } from "@/lib/api";
import { formatReference, parseReferenceTick, referenceChange, type ReferenceRow } from "@/lib/reference";
import { subscribe } from "@/lib/socket";
import { everyVisible } from "@/lib/visible-interval";

function toneClass(delta: number | null): string {
  return delta == null ? "text-ink-faint" : delta > 0 ? "text-up" : delta < 0 ? "text-down" : "text-ink-muted";
}

/**
 * 원/달러·원자재 가상 지수 목록(선물 기초자산). 값은 소켓으로 1초마다 오고, 기준값·추세선은
 * 30초마다 다시 읽는다. 증권 탭과 대시보드가 같은 목록을 쓴다.
 */
export default function ReferenceList() {
  const [rows, setRows] = useState<ReferenceRow[]>([]);
  const [live, setLive] = useState<Record<string, number>>({});

  useEffect(() => {
    let active = true;
    const load = () =>
      api<ReferenceRow[]>("/market/reference", { auth: false })
        .then((data) => {
          if (active) setRows(data);
        })
        .catch(() => {});
    load();
    const stop = everyVisible(load, 30_000);
    return () => {
      active = false;
      stop();
    };
  }, []);

  const codes = rows.map((row) => row.code).join(",");
  useEffect(() => {
    if (!codes) return;
    return subscribe(
      codes.split(",").map((code) => `ref:${code}`),
      ({ data }) => {
        const tick = parseReferenceTick(data);
        if (tick) setLive((prev) => (prev[tick.code] === tick.value ? prev : { ...prev, [tick.code]: tick.value }));
      },
    );
  }, [codes]);

  const list = useMemo(
    () =>
      rows.map((row) => {
        const value = live[row.code] ?? row.value;
        const spark = row.spark.length > 0 && value != null ? [...row.spark.slice(0, -1), value] : row.spark;
        return { ...row, value, spark, change: referenceChange(value, row.base) };
      }),
    [rows, live],
  );

  return (
    <ul className="divide-y divide-hairline-soft">
      {list.map((row) => {
        const tone = row.spark.length > 1 ? (row.spark.at(-1)! > row.spark[0] ? "up" : row.spark.at(-1)! < row.spark[0] ? "down" : "flat") : "flat";
        return (
          <li key={row.code}>
            <Link
              href={`/reference/${row.code}`}
              className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-surface-3/30 active:bg-surface-3/45"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate font-semibold">{row.name}</span>
                <span className="num block truncate text-xs text-ink-faint">{row.code}</span>
              </span>
              <span className="hidden min-[380px]:block">
                <Sparkline values={row.spark.map((v) => v / row.scale)} tone={tone} width={64} height={28} />
              </span>
              <span className="w-[6.5rem] shrink-0 text-right">
                <span className="num block font-semibold">{formatReference(row.value, row)}</span>
                <span className={`num block text-xs font-medium ${toneClass(row.change)}`}>
                  {row.change == null ? "—" : `${row.change > 0 ? "+" : ""}${row.change.toFixed(2)}%`}
                </span>
              </span>
            </Link>
          </li>
        );
      })}
      {list.length === 0 && <li className="py-8 text-center text-sm text-ink-faint">불러오는 중…</li>}
    </ul>
  );
}
