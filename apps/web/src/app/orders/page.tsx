"use client";

import { describeCondition, type ConditionalOrderDto } from "@mock-kabu/shared";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { api, fmt, getToken, getUser, won } from "@/lib/api";
import { formatKstTime, MARKET_TIME_ZONE_LABEL } from "@/lib/time";
import { subscribe } from "@/lib/socket";

interface OrderRow {
  id: string;
  symbol: string;
  side: "BUY" | "SELL";
  type: string;
  price: number | null;
  qty: number;
  filledQty: number;
  status: string;
  createdAt: string;
}

interface FillRow {
  tradeId: string;
  symbol: string;
  side: "BUY" | "SELL" | "SELF";
  price: number;
  qty: number;
  amount: number;
  taker: boolean;
  realized: number | null;
  costBasis: number | null;
  ts: number;
}

const STATUS_LABEL: Record<string, string> = {
  OPEN: "접수",
  PARTIAL: "부분체결",
  FILLED: "체결완료",
  CANCELED: "취소",
  REJECTED: "거부",
};

/** Only terminal-negative and in-flight states earn a colour; the rest stay quiet. */
const STATUS_TONE: Record<string, string> = {
  FILLED: "chip-live",
  REJECTED: "chip-up",
  PARTIAL: "chip-down",
};

type Tab = "orders" | "fills" | "conditional";

const TABS: { id: Tab; label: string; title: string; hint: string }[] = [
  { id: "orders", label: "주문", title: "주문 내역", hint: "최근 100건의 주문을 실시간으로 반영합니다." },
  {
    id: "fills",
    label: "체결",
    title: "체결 내역",
    hint: "최근 100건의 체결과 매도 실현손익을 실시간으로 반영합니다.",
  },
  {
    id: "conditional",
    label: "예약",
    title: "예약 주문",
    hint: "조건부(손절·익절·돌파·눌림) 주문의 대기·발동·취소 이력입니다.",
  },
];

const CONDITIONAL_STATUS_LABEL: Record<ConditionalOrderDto["status"], string> = {
  WAITING: "대기",
  TRIGGERED: "발동",
  CANCELED: "취소",
  FAILED: "실패",
};
const CONDITIONAL_STATUS_TONE: Record<ConditionalOrderDto["status"], string> = {
  WAITING: "chip-down",
  TRIGGERED: "chip-live",
  CANCELED: "",
  FAILED: "chip-up",
};

const TAB_STORAGE_KEY = "orders:tab";

export default function OrdersPage() {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("orders");
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [fills, setFills] = useState<FillRow[]>([]);
  const [conditional, setConditional] = useState<ConditionalOrderDto[]>([]);

  const load = useCallback(() => {
    api<OrderRow[]>("/orders?limit=100").then(setOrders).catch(() => {});
    api<FillRow[]>("/account/trades?limit=100").then(setFills).catch(() => {});
    api<ConditionalOrderDto[]>("/orders/conditional?limit=100").then(setConditional).catch(() => {});
  }, []);

  async function cancelConditional(id: string) {
    try {
      await api(`/orders/conditional/${id}`, { method: "DELETE" });
    } catch {
      // 그 사이 발동됐을 수 있다 — 목록을 다시 읽어 실제 상태를 보여준다.
    }
    load();
  }

  // localStorage는 마운트 후에만 읽는다 — useState 초기값에서 읽으면 hydration mismatch.
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(TAB_STORAGE_KEY);
      if (saved === "orders" || saved === "fills" || saved === "conditional") setTab(saved);
    } catch {
      // 비공개 창 등에서 storage 접근이 막혀도 기본 탭으로 동작한다.
    }
  }, []);

  function selectTab(next: Tab) {
    setTab(next);
    try {
      window.localStorage.setItem(TAB_STORAGE_KEY, next);
    } catch {
      // ignore
    }
  }

  useEffect(() => {
    if (!getToken()) {
      router.push("/login");
      return;
    }
    load();
    const user = getUser();
    const unsub = user ? subscribe([`account:${user.accountId}`], () => load()) : () => {};
    // Realtime account notifications normally update this immediately.
    const t = setInterval(load, 15_000);
    return () => {
      unsub();
      clearInterval(t);
    };
  }, [load, router]);

  const current = TABS.find((t) => t.id === tab) ?? TABS[0];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{current.title}</h1>
          <p className="mt-1 text-sm text-ink-muted">{current.hint}</p>
        </div>
        <div className="well flex gap-0.5 p-0.5" role="tablist" aria-label="내역 종류">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => selectTab(t.id)}
              className={`rounded-lg px-3 py-1 text-xs font-medium transition-colors ${
                tab === t.id
                  ? "bg-sky/15 text-sky ring-1 ring-inset ring-sky/35"
                  : "text-ink-muted hover:bg-white/6 hover:text-ink"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div className="glass overflow-hidden">
        <div className="overflow-x-auto">
          {tab === "orders" ? (
            <OrdersTable orders={orders} />
          ) : tab === "fills" ? (
            <FillsTable fills={fills} />
          ) : (
            <ConditionalTable rows={conditional} onCancel={cancelConditional} />
          )}
        </div>
      </div>
    </div>
  );
}

function OrdersTable({ orders }: { orders: OrderRow[] }) {
  return (
    <table className="tbl tbl-hover">
      <thead>
        <tr>
          <th>시각 ({MARKET_TIME_ZONE_LABEL})</th>
          <th>종목</th>
          <th>구분</th>
          <th className="text-right">가격</th>
          <th className="text-right">체결/수량</th>
          <th className="text-right">상태</th>
        </tr>
      </thead>
      <tbody>
        {orders.map((o) => (
          <tr key={o.id}>
            <td className="num whitespace-nowrap text-ink-muted">
              {formatKstTime(new Date(o.createdAt).getTime())}
            </td>
            <td className="font-semibold">{o.symbol}</td>
            <td>
              <span className={`font-medium ${o.side === "BUY" ? "text-up" : "text-down"}`}>
                {o.side === "BUY" ? "매수" : "매도"}
              </span>
              <span className="ml-1.5 text-xs text-ink-faint">
                {o.type === "LIMIT" ? "지정가" : "시장가"}
              </span>
            </td>
            <td className="num text-right">{o.price != null ? fmt.format(o.price) : "—"}</td>
            <td className="num text-right">
              {fmt.format(o.filledQty)}
              <span className="text-ink-faint">/{fmt.format(o.qty)}</span>
            </td>
            <td className="text-right">
              <span className={`chip ${STATUS_TONE[o.status] ?? ""}`}>
                {STATUS_LABEL[o.status] ?? o.status}
              </span>
            </td>
          </tr>
        ))}
        {orders.length === 0 && (
          <tr>
            <td colSpan={6} className="py-14 text-center text-sm text-ink-faint">
              주문 내역이 없습니다
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

const SIDE_LABEL: Record<FillRow["side"], string> = { BUY: "매수", SELL: "매도", SELF: "자전" };

function FillsTable({ fills }: { fills: FillRow[] }) {
  return (
    <table className="tbl tbl-hover">
      <thead>
        <tr>
          <th>시각 ({MARKET_TIME_ZONE_LABEL})</th>
          <th>종목</th>
          <th>구분</th>
          <th className="text-right">체결가</th>
          <th className="text-right">수량</th>
          <th className="text-right">체결금액</th>
          <th className="text-right" title="매도 체결에서 평단가 대비 확정된 손익">
            실현손익
          </th>
        </tr>
      </thead>
      <tbody>
        {fills.map((f) => {
          const sideTone = f.side === "BUY" ? "text-up" : f.side === "SELL" ? "text-down" : "text-ink-muted";
          return (
            <tr key={f.tradeId}>
              <td className="num whitespace-nowrap text-ink-muted">{formatKstTime(f.ts)}</td>
              <td className="font-semibold">{f.symbol}</td>
              <td>
                <span className={`font-medium ${sideTone}`}>{SIDE_LABEL[f.side]}</span>
                <span
                  className="ml-1.5 text-xs text-ink-faint"
                  title={f.taker ? "내 주문이 기존 호가를 체결시켰습니다" : "내 호가에 상대 주문이 체결됐습니다"}
                >
                  {f.taker ? "테이커" : "메이커"}
                </span>
              </td>
              <td className="num text-right">{fmt.format(f.price)}</td>
              <td className="num text-right">{fmt.format(f.qty)}</td>
              <td className="num text-right">{won(f.amount)}</td>
              <td className="num text-right">
                {f.realized == null ? (
                  <span className="text-ink-faint">—</span>
                ) : (
                  <RealizedCell realized={f.realized} costBasis={f.costBasis} />
                )}
              </td>
            </tr>
          );
        })}
        {fills.length === 0 && (
          <tr>
            <td colSpan={7} className="py-14 text-center text-sm text-ink-faint">
              체결 내역이 없습니다
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

function ConditionalTable({
  rows,
  onCancel,
}: {
  rows: ConditionalOrderDto[];
  onCancel: (id: string) => void;
}) {
  return (
    <table className="tbl tbl-hover">
      <thead>
        <tr>
          <th>등록 ({MARKET_TIME_ZONE_LABEL})</th>
          <th>종목</th>
          <th>조건</th>
          <th className="text-right">트리거</th>
          <th className="text-right">수량</th>
          <th className="text-right" title="발동을 일으킨 체결가">
            발동가
          </th>
          <th className="text-right">상태</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id} title={r.failReason ?? undefined}>
            <td className="num whitespace-nowrap text-ink-muted">
              {formatKstTime(new Date(r.createdAt).getTime())}
            </td>
            <td className="font-semibold">{r.symbol}</td>
            <td>
              <span className={`font-medium ${r.side === "BUY" ? "text-up" : "text-down"}`}>
                {r.trailBps != null
                  ? `${r.side === "SELL" ? "트레일링 손절" : "트레일링 매수"} ${(r.trailBps / 100).toFixed(
                      r.trailBps % 100 === 0 ? 0 : 1,
                    )}%`
                  : describeCondition(r.direction, r.side)}
              </span>
              {r.ocoGroupId && (
                <span className="chip ml-1.5" title="OCO — 짝 주문이 발동하면 자동 취소">
                  OCO
                </span>
              )}
            </td>
            <td className="num text-right">
              {fmt.format(r.triggerPrice)}
              <span className="text-ink-faint">{r.direction === "AT_OR_ABOVE" ? " 이상" : " 이하"}</span>
            </td>
            <td className="num text-right">{fmt.format(r.qty)}</td>
            <td className="num text-right text-ink-muted">
              {r.triggerTradePrice != null ? fmt.format(r.triggerTradePrice) : "—"}
            </td>
            <td className="text-right">
              <span className={`chip ${CONDITIONAL_STATUS_TONE[r.status]}`}>
                {CONDITIONAL_STATUS_LABEL[r.status]}
              </span>
              {r.failReason && r.status !== "WAITING" && (
                <span className="ml-1.5 text-[11px] text-ink-faint">{r.failReason}</span>
              )}
            </td>
            <td className="text-right">
              {r.status === "WAITING" && (
                <button onClick={() => onCancel(r.id)} className="btn btn-ghost btn-sm">
                  취소
                </button>
              )}
            </td>
          </tr>
        ))}
        {rows.length === 0 && (
          <tr>
            <td colSpan={8} className="py-14 text-center text-sm text-ink-faint">
              예약 주문이 없습니다
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

function RealizedCell({ realized, costBasis }: { realized: number; costBasis: number | null }) {
  const tone = realized > 0 ? "text-up" : realized < 0 ? "text-down" : "text-ink-muted";
  const sign = realized > 0 ? "+" : "";
  const rate = costBasis && costBasis > 0 ? (realized / costBasis) * 100 : null;
  return (
    <span className={`font-medium ${tone}`}>
      {sign}
      {won(realized)}
      {rate != null && (
        <span className="ml-1 text-xs opacity-80">
          ({sign}
          {rate.toFixed(2)}%)
        </span>
      )}
    </span>
  );
}
