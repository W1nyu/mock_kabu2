"use client";

import { isFuture } from "@mock-kabu/shared";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { fmt, getUser } from "@/lib/api";
import { fmtFuture, krw } from "@/lib/futures";
import { pushNotification, showDesktopNotification } from "@/lib/notifications";
import { subscribe } from "@/lib/socket";

interface Toast {
  id: string;
  tone: "up" | "down" | "info" | "warn";
  title: string;
  detail?: string;
  href?: string;
}

const MAX_VISIBLE = 4;
const DISMISS_MS = 6_000;
/** 같은 종목·방향의 체결이 이 시간 안에 이어지면 한 토스트로 합친다 (봇 계정 로그인 시 폭주 방지). */
const COALESCE_MS = 1_500;

interface PendingFill {
  key: string;
  symbol: string;
  side: "BUY" | "SELL";
  qty: number;
  amount: number;
  count: number;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * 계정 채널 push(체결·예약 주문 발동)를 화면 우하단 토스트로 보여준다. 어느 페이지에 있든
 * 내 계좌에 일어난 일을 놓치지 않게 하는 게 목적이고, 데이터 갱신은 각 컴포넌트가 따로 한다.
 */
export default function Toaster() {
  const pathname = usePathname();
  const [toasts, setToasts] = useState<Toast[]>([]);
  const pendingRef = useRef(new Map<string, PendingFill>());
  const seenTradesRef = useRef(new Set<string>());

  useEffect(() => {
    const user = getUser();
    if (!user) return;
    const pending = pendingRef.current;

    const push = (toast: Toast) => {
      // 토스트는 사라지지만 알림함에는 남는다. 탭이 가려져 있으면 시스템 알림도 띄운다(설정에서 켠 경우).
      pushNotification(user.accountId, { ...toast, ts: Date.now() });
      showDesktopNotification(toast);
      setToasts((current) => [...current.slice(-(MAX_VISIBLE - 1)), toast]);
      window.setTimeout(() => {
        setToasts((current) => current.filter((t) => t.id !== toast.id));
      }, DISMISS_MS);
    };

    const flushFill = (key: string) => {
      const fill = pending.get(key);
      if (!fill) return;
      pending.delete(key);
      const avg = fill.qty > 0 ? Math.round(fill.amount / fill.qty) : 0;
      if (isFuture(fill.symbol)) {
        push({
          id: `fill:${key}:${Date.now()}`,
          href: `/futures/${fill.symbol}`,
          tone: fill.side === "BUY" ? "up" : "down",
          title: `${fill.symbol} ${fill.side === "BUY" ? "매수" : "매도"} 체결 ${fmt.format(fill.qty)}계약`,
          detail: fill.count > 1 ? `${fill.count}건 · 평균 ${fmtFuture(fill.symbol, avg)}` : fmtFuture(fill.symbol, avg),
        });
        return;
      }
      push({
        id: `fill:${key}:${Date.now()}`,
        href: `/symbol/${fill.symbol}`,
        tone: fill.side === "BUY" ? "up" : "down",
        title: `${fill.symbol} ${fill.side === "BUY" ? "매수" : "매도"} 체결 ${fmt.format(fill.qty)}주`,
        detail:
          fill.count > 1
            ? `${fill.count}건 · 평균 ${fmt.format(avg)}원`
            : `${fmt.format(avg)}원`,
      });
    };

    const unsubscribe = subscribe([`account:${user.accountId}`], ({ data }) => {
      if (!data || typeof data !== "object") return;
      if (data.type === "trade") {
        const tradeId = typeof data.tradeId === "string" ? data.tradeId : null;
        if (tradeId) {
          if (seenTradesRef.current.has(tradeId)) return;
          seenTradesRef.current.add(tradeId);
          if (seenTradesRef.current.size > 500) {
            seenTradesRef.current = new Set([...seenTradesRef.current].slice(-250));
          }
        }
        const side = data.side === "SELL" ? "SELL" : "BUY";
        const symbol = String(data.symbol ?? "");
        const qty = Number(data.qty) || 0;
        const price = Number(data.price) || 0;
        const key = `${symbol}:${side}`;
        const existing = pending.get(key);
        if (existing) {
          clearTimeout(existing.timer);
          existing.qty += qty;
          existing.amount += qty * price;
          existing.count += 1;
          existing.timer = setTimeout(() => flushFill(key), COALESCE_MS);
        } else {
          pending.set(key, {
            key,
            symbol,
            side,
            qty,
            amount: qty * price,
            count: 1,
            timer: setTimeout(() => flushFill(key), COALESCE_MS),
          });
        }
        return;
      }
      if (data.type === "futures_settled" && typeof data.symbol === "string") {
        const realized = Number(data.realized);
        push({
          id: `futures-settled:${data.symbol}:${data.tradingDay}`,
          href: `/futures/${data.symbol}`,
          tone: realized > 0 ? "up" : realized < 0 ? "down" : "info",
          title: `${data.symbol} 일일 정산`,
          detail: `결제가 ${fmtFuture(data.symbol, Number(data.price))} · 정산손익 ${realized > 0 ? "+" : ""}${krw(realized || 0)}`,
        });
        return;
      }
      if (data.type === "futures_margin_call") {
        const at = Date.now();
        if (data.status === "OPEN") {
          const deadline = new Date(String(data.deadline));
          push({
            id: `margin-call:${at}`,
            href: "/market?kind=futures",
            tone: "warn",
            title: "선물 추가증거금 발생",
            detail: `${krw(Number(data.required))} · ${deadline.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Seoul" })}까지 채우지 않으면 반대매매`,
          });
        } else if (data.status === "RESOLVED") {
          push({ id: `margin-call:${at}`, tone: "info", title: "선물 추가증거금 해소", detail: "위탁증거금 수준을 회복했습니다" });
        } else if (data.status === "LIQUIDATED" || data.status === "EMERGENCY") {
          push({
            id: `margin-call:${at}`,
            tone: "down",
            title: data.status === "EMERGENCY" ? "선물 긴급 반대매매" : "선물 반대매매",
            detail:
              data.status === "EMERGENCY"
                ? `평가손실이 증거금의 90%에 닿아 ${Array.isArray(data.symbols) ? data.symbols.join(", ") : ""} 포지션을 시장가로 청산합니다`
                : "추가증거금 기한이 지나 포지션 일부를 시장가로 청산합니다",
          });
        }
        return;
      }
      if (data.type === "bracket" && data.status === "ARMED") {
        push({
          id: `bracket:${data.id}`,
          href: `/symbol/${data.symbol}`,
          tone: "info",
          title: `${data.symbol} 손절/익절 자동 등록`,
          detail: `체결 ${fmt.format(Number(data.qty))}주 · 평균 ${fmt.format(Number(data.avgFillPrice))}원 · ${String(data.note ?? "")}`,
        });
        return;
      }
      if (data.type === "conditional" && typeof data.label === "string") {
        if (data.status === "TRIGGERED") {
          push({
            id: `cond:${data.id}`,
            href: `/symbol/${data.symbol}`,
            tone: "info",
            title: `${data.symbol} ${data.label} 발동`,
            detail: `${fmt.format(Number(data.triggerPrice))}원 도달 · ${fmt.format(Number(data.qty))}주 시장가 접수`,
          });
        } else if (data.status === "FAILED") {
          push({
            id: `cond:${data.id}`,
            href: `/symbol/${data.symbol}`,
            tone: "warn",
            title: `${data.symbol} ${data.label} 발동했지만 접수 실패`,
            detail: String(data.failReason ?? "사유 없음"),
          });
        }
      }
    });

    return () => {
      unsubscribe();
      for (const fill of pending.values()) clearTimeout(fill.timer);
      pending.clear();
    };
    // 로그인/로그아웃은 페이지 이동을 동반하므로 pathname 변화 때 구독을 다시 맺는다.
  }, [pathname]);

  if (toasts.length === 0) return null;

  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed right-4 bottom-[calc(5.5rem+env(safe-area-inset-bottom))] z-[70] sm:bottom-4 flex w-[min(22rem,calc(100vw-2rem))] flex-col gap-2"
    >
      {toasts.map((toast) => {
        const accent =
          toast.tone === "up"
            ? "border-up/40 bg-up/10"
            : toast.tone === "down"
              ? "border-down/40 bg-down/10"
              : toast.tone === "warn"
                ? "border-warn/40 bg-warn/10"
                : "border-sky/40 bg-sky/10";
        return (
          <div
            key={toast.id}
            className={`pointer-events-auto rounded-control border px-3.5 py-2.5 text-sm shadow-lg backdrop-blur-glass ${accent} bg-abyss/80`}
          >
            <p className="num font-semibold">{toast.title}</p>
            {toast.detail && <p className="num mt-0.5 text-xs text-ink-muted">{toast.detail}</p>}
          </div>
        );
      })}
    </div>
  );
}
