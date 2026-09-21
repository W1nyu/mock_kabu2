"use client";

import type { ConditionalOrderDto } from "@mock-kabu/shared";
import { useEffect, useState } from "react";
import { api, getToken, getUser } from "@/lib/api";
import { subscribe } from "@/lib/socket";

export interface PositionLine {
  id: string;
  price: number;
  color: string;
  title: string;
  /** 0=실선 1=점선 2=파선 (lightweight-charts LineStyle) */
  style: 0 | 1 | 2;
}

interface HoldingRow {
  symbol: string;
  qty: number;
  avgCost: number;
}

const AVG_COLOR = "#f5f5f5";
const STOP_COLOR = "#6e8aff";
const TAKE_COLOR = "#ff5a6e";
const TRAIL_COLOR = "#fbbf24";

/**
 * 차트 위에 그릴 내 포지션 관련 가격선: 평단가와 대기 중인 예약 주문의 트리거.
 * 계정 push(account:{id})가 오면 다시 읽고, 트레일링 트리거는 움직이므로 15초 폴백도 둔다.
 */
export function usePositionLines(symbol: string): PositionLine[] {
  const [lines, setLines] = useState<PositionLine[]>([]);

  useEffect(() => {
    if (!getToken()) return;
    let active = true;
    setLines([]);

    const load = () => {
      Promise.all([
        api<HoldingRow[]>("/account/holdings").catch(() => [] as HoldingRow[]),
        api<ConditionalOrderDto[]>(`/orders/conditional?symbol=${symbol}&status=WAITING&limit=20`).catch(
          () => [] as ConditionalOrderDto[],
        ),
      ]).then(([holdings, conditional]) => {
        if (!active) return;
        const next: PositionLine[] = [];
        const holding = holdings.find((h) => h.symbol === symbol && h.qty > 0);
        if (holding && holding.avgCost > 0) {
          next.push({
            id: "avg",
            price: Math.round(holding.avgCost),
            color: AVG_COLOR,
            title: `평단 ${holding.qty.toLocaleString("ko-KR")}주`,
            style: 2,
          });
        }
        for (const row of conditional) {
          const trailing = row.trailBps != null;
          const sell = row.side === "SELL";
          const label = trailing
            ? `트레일링 ${sell ? "손절" : "매수"}`
            : sell
              ? row.direction === "AT_OR_BELOW"
                ? "손절"
                : "익절"
              : row.direction === "AT_OR_ABOVE"
                ? "돌파 매수"
                : "눌림 매수";
          next.push({
            id: row.id,
            price: row.triggerPrice,
            color: trailing ? TRAIL_COLOR : row.direction === "AT_OR_BELOW" ? STOP_COLOR : TAKE_COLOR,
            title: `${label} ${row.qty.toLocaleString("ko-KR")}주`,
            style: 1,
          });
        }
        setLines(next);
      });
    };

    load();
    const user = getUser();
    const unsub = user ? subscribe([`account:${user.accountId}`], () => load()) : () => {};
    const t = window.setInterval(load, 15_000);
    return () => {
      active = false;
      unsub();
      window.clearInterval(t);
    };
  }, [symbol]);

  return lines;
}
