"use client";

import {
  describeCondition,
  type BracketIntentDto,
  type ConditionalOrderDto,
} from "@mock-kabu/shared";
import { useCallback, useEffect, useState } from "react";
import { api, fmt, getUser } from "@/lib/api";
import { ACCOUNT_REFRESH_DEBOUNCE_MS, debounce } from "@/lib/debounce";
import { formatKstTime } from "@/lib/time";
import { subscribe } from "@/lib/socket";

const STATUS_LABEL: Record<ConditionalOrderDto["status"], string> = {
  WAITING: "대기",
  TRIGGERED: "발동",
  CANCELED: "취소",
  FAILED: "실패",
};

/** 트레일링이면 추적 거리를 함께 적는다 — 트리거 가격이 계속 움직이므로 무엇을 따르는지 보여야 한다. */
function conditionLabel(r: ConditionalOrderDto): string {
  if (r.trailBps != null) {
    return `${r.side === "SELL" ? "트레일링 손절" : "트레일링 매수"} ${(r.trailBps / 100).toFixed(
      r.trailBps % 100 === 0 ? 0 : 1,
    )}%`;
  }
  return describeCondition(r.direction, r.side);
}

/** 최근 이력은 몇 건만 보여 대기 목록이 밀리지 않게 한다. */
const HISTORY_LIMIT = 5;

/**
 * 해당 종목의 조건부(예약) 주문. 대기 중인 행은 취소할 수 있고, 발동/실패한 최근 이력은
 * 왜 그렇게 됐는지(발동 체결가·실패 사유)를 함께 보여준다.
 */
export default function MyConditionalOrders({
  symbol,
  refreshKey,
}: {
  symbol: string;
  refreshKey?: number;
}) {
  const [rows, setRows] = useState<ConditionalOrderDto[]>([]);
  const [pendingBrackets, setPendingBrackets] = useState<BracketIntentDto[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api<ConditionalOrderDto[]>(`/orders/conditional?symbol=${symbol}&limit=50`)
      .then(setRows)
      .catch(() => {});
    api<BracketIntentDto[]>(`/orders/bracket?symbol=${symbol}&limit=20`)
      .then((intents) =>
        setPendingBrackets(intents.filter((intent) => intent.status === "PENDING")),
      )
      .catch(() => {});
  }, [symbol]);

  async function cancelBracket(id: string) {
    try {
      await api(`/orders/bracket/${id}`, { method: "DELETE" });
    } catch {
      // 그 사이 체결돼 이미 등록됐을 수 있다.
    }
    refresh();
  }

  useEffect(() => {
    setRows([]);
    setNotice(null);
    refresh();
  }, [refresh, refreshKey]);

  useEffect(() => {
    const user = getUser();
    const refreshSoon = debounce(refresh, ACCOUNT_REFRESH_DEBOUNCE_MS);
    const unsub = user
      ? subscribe([`account:${user.accountId}`], ({ data }) => {
          if (data?.type === "bracket" && data?.symbol === symbol && data?.status === "ARMED") {
            setNotice(
              `체결 ${fmt.format(data.qty)}주 · ${String(data.note ?? "손절/익절 자동 등록")}`,
            );
          }
          if (data?.type === "conditional" && data?.symbol === symbol && data?.label) {
            setNotice(
              data.status === "TRIGGERED"
                ? `${data.label} 발동 — ${fmt.format(data.qty)}주 시장가 접수`
                : `${data.label} 발동했지만 접수 실패: ${data.failReason ?? "사유 없음"}`,
            );
          }
          refreshSoon();
        })
      : () => {};
    const t = setInterval(refresh, 15_000);
    return () => {
      unsub();
      refreshSoon.cancel();
      clearInterval(t);
    };
  }, [refresh, symbol]);

  async function cancel(id: string) {
    try {
      await api(`/orders/conditional/${id}`, { method: "DELETE" });
    } catch {
      // 그 사이 발동됐을 수 있다 — 목록을 다시 읽어 상태를 보여준다.
    }
    refresh();
  }

  const waiting = rows.filter((r) => r.status === "WAITING");
  const history = rows.filter((r) => r.status !== "WAITING").slice(0, HISTORY_LIMIT);

  if (rows.length === 0 && pendingBrackets.length === 0 && !notice) return null;

  return (
    <div className="glass flex flex-col overflow-hidden">
      <div className="panel-head">
        <span className="panel-title">예약 주문</span>
        {waiting.length > 0 && <span className="chip">{waiting.length}</span>}
      </div>
      {notice && (
        <p className="border-b border-hairline-soft px-4 py-2 text-xs text-sky">{notice}</p>
      )}
      <ul className="num max-h-72 flex-1 overflow-y-auto text-xs">
        {pendingBrackets.map((intent) => (
          <li
            key={intent.id}
            className="flex items-center gap-2 border-b border-hairline-soft bg-sky/4 px-4 py-2"
            title="매수 주문이 체결되면 체결 평균가 기준으로 손절/익절 OCO를 등록합니다"
          >
            <span className="w-8 shrink-0 font-semibold text-sky">대기</span>
            <span className="shrink-0 text-ink-muted">체결 후 자동 보호</span>
            <span className="ml-auto whitespace-nowrap">
              <span className="text-down">손절 −{(intent.stopBps / 100).toFixed(1)}%</span>
              <span className="text-ink-faint"> · </span>
              <span className="text-up">익절 +{(intent.takeBps / 100).toFixed(1)}%</span>
            </span>
            <button
              onClick={() => cancelBracket(intent.id)}
              className="btn btn-ghost btn-sm shrink-0"
            >
              취소
            </button>
          </li>
        ))}
        {waiting.map((r) => (
          <li
            key={r.id}
            className="flex items-center gap-2 border-b border-hairline-soft px-4 py-2 last:border-b-0"
          >
            <span
              className={`w-8 shrink-0 font-semibold ${r.side === "BUY" ? "text-up" : "text-down"}`}
            >
              {r.side === "BUY" ? "매수" : "매도"}
            </span>
            <span className="shrink-0 text-ink-muted">{conditionLabel(r)}</span>
            {r.ocoGroupId && (
              <span className="chip" title="OCO — 짝 주문이 발동하면 자동 취소됩니다">
                OCO
              </span>
            )}
            <span
              className="ml-auto whitespace-nowrap"
              title={r.watermark != null ? `추적 기준 ${fmt.format(r.watermark)}원` : undefined}
            >
              {fmt.format(r.triggerPrice)}
              <span className="text-ink-faint">
                {r.direction === "AT_OR_ABOVE" ? " 이상" : " 이하"}
              </span>
            </span>
            <span className="w-12 shrink-0 text-right text-ink-faint">{fmt.format(r.qty)}주</span>
            <button onClick={() => cancel(r.id)} className="btn btn-ghost btn-sm shrink-0">
              취소
            </button>
          </li>
        ))}
        {waiting.length === 0 && pendingBrackets.length === 0 && (
          <li className="px-4 py-3 text-center text-ink-faint">대기 중인 예약 주문 없음</li>
        )}
        {history.map((r) => {
          const tone =
            r.status === "TRIGGERED"
              ? "text-ok"
              : r.status === "FAILED"
                ? "text-warn"
                : "text-ink-faint";
          return (
            <li
              key={r.id}
              title={r.failReason ?? undefined}
              className="flex items-center gap-2 border-t border-hairline-soft bg-surface-3/15 px-4 py-1.5 text-ink-faint"
            >
              <span className={`w-8 shrink-0 ${tone}`}>{STATUS_LABEL[r.status]}</span>
              <span className="shrink-0">
                {r.side === "BUY" ? "매수" : "매도"} {fmt.format(r.qty)}주
              </span>
              <span className="ml-auto whitespace-nowrap">
                {fmt.format(r.triggerPrice)}
                {r.direction === "AT_OR_ABOVE" ? " 이상" : " 이하"}
                {r.triggerTradePrice != null && ` → ${fmt.format(r.triggerTradePrice)}`}
              </span>
              <span className="w-14 shrink-0 text-right">
                {formatKstTime(new Date(r.triggeredAt ?? r.createdAt).getTime())}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
