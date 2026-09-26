"use client";

import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { parseReferenceTick, referenceChange, type ReferenceRow } from "@/lib/reference";
import { subscribe } from "@/lib/socket";
import { everyVisible } from "@/lib/visible-interval";

export interface LiveReferenceRow extends ReferenceRow {
  /** 오늘 등락률(%), 기준값이 없으면 null */
  change: number | null;
}

/**
 * 원/달러·원자재 가상 지수 시세. 값은 소켓으로 1초마다 오고, 기준값·추세선은 30초마다 다시 읽는다.
 * 증권 탭 카드·원자재 화면·대시보드 목록이 같은 방식으로 쓴다.
 */
export function useReferenceRows(): LiveReferenceRow[] {
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

  return useMemo(
    () =>
      rows.map((row) => {
        const value = live[row.code] ?? row.value;
        const spark = row.spark.length > 0 && value != null ? [...row.spark.slice(0, -1), value] : row.spark;
        return { ...row, value, spark, change: referenceChange(value, row.base) };
      }),
    [rows, live],
  );
}

/** 환율(원/달러) 코드 — 증권 탭에서 원자재와 따로 보여 준다. */
export const FX_CODE = "USDKRW";
