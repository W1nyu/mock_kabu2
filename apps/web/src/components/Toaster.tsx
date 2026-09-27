"use client";

import { isFuture, isOption } from "@mock-kabu/shared";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { fmt, getUser, won } from "@/lib/api";
import { fmtFuture, krw } from "@/lib/futures";
import { pushNotification, showDesktopNotification } from "@/lib/notifications";
import { subscribe } from "@/lib/socket";
import { getLocale, serverText, translate, type Vars } from "@/lib/i18n";

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

/** 포지션 키("KABUF:LONG", 순포지션은 "KABUF")를 "KABUF 롱"처럼 읽히게 바꾼다. */
function positionKeyLabel(key: string, tr: (ko: string) => string): string {
  const [symbol, side] = key.split(":");
  if (side === "LONG") return `${symbol} ${tr("롱")}`;
  if (side === "SHORT") return `${symbol} ${tr("숏")}`;
  return symbol;
}

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
    // 알림 문구는 받은 순간의 화면 언어로 만든다(알림함에도 그대로 남는다).
    const tr = (ko: string, vars?: Vars) => translate(getLocale(), ko, vars);

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
      if (isFuture(fill.symbol) || isOption(fill.symbol)) {
        push({
          id: `fill:${key}:${Date.now()}`,
          href: `/${isOption(fill.symbol) ? "options" : "futures"}/${fill.symbol}`,
          tone: fill.side === "BUY" ? "up" : "down",
          title: tr(fill.side === "BUY" ? "{symbol} 매수 체결 {n}계약" : "{symbol} 매도 체결 {n}계약", {
            symbol: fill.symbol,
            n: fmt.format(fill.qty),
          }),
          detail:
            fill.count > 1 ? tr("{count}건 · 평균 {price}", { count: fill.count, price: fmtFuture(fill.symbol, avg) }) : fmtFuture(fill.symbol, avg),
        });
        return;
      }
      push({
        id: `fill:${key}:${Date.now()}`,
        href: `/symbol/${fill.symbol}`,
        tone: fill.side === "BUY" ? "up" : "down",
        title: tr(fill.side === "BUY" ? "{symbol} 매수 체결 {n}주" : "{symbol} 매도 체결 {n}주", {
          symbol: fill.symbol,
          n: fmt.format(fill.qty),
        }),
        detail: fill.count > 1 ? tr("{count}건 · 평균 {price}", { count: fill.count, price: won(avg) }) : won(avg),
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
        // 양방향 계정은 같은 종목의 롱·숏이 따로 정산된다 — 알림이 하나로 합쳐지지 않게 방향을 넣는다.
        const hedgeSide = data.positionSide === "LONG" || data.positionSide === "SHORT" ? data.positionSide : null;
        push({
          id: `futures-settled:${data.symbol}:${hedgeSide ?? "NET"}:${data.tradingDay}`,
          href: `/${isOption(data.symbol) ? "options" : "futures"}/${data.symbol}`,
          tone: realized > 0 ? "up" : realized < 0 ? "down" : "info",
          title: tr(isOption(data.symbol) ? "{symbol} 만기 정산" : "{symbol} 일일 정산", {
            symbol: positionKeyLabel(hedgeSide ? `${data.symbol}:${hedgeSide}` : data.symbol, tr),
          }),
          detail: tr(isOption(data.symbol) ? "내재가치 {price} · 정산손익 {pnl}" : "결제가 {price} · 정산손익 {pnl}", {
            price: fmtFuture(data.symbol, Number(data.price)),
            pnl: `${realized > 0 ? "+" : ""}${krw(realized || 0)}`,
          }),
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
            title: tr("선물 추가증거금 발생"),
            detail: tr("{amount} · {time}까지 채우지 않으면 반대매매", {
              amount: krw(Number(data.required)),
              time: deadline.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Seoul" }),
            }),
          });
        } else if (data.status === "RESOLVED") {
          push({ id: `margin-call:${at}`, tone: "info", title: tr("선물 추가증거금 해소"), detail: tr("위탁증거금 수준을 회복했습니다") });
        } else if (data.status === "LIQUIDATED" || data.status === "EMERGENCY") {
          push({
            id: `margin-call:${at}`,
            tone: "down",
            title: data.status === "EMERGENCY" ? tr("선물 긴급 반대매매") : tr("선물 반대매매"),
            detail:
              data.status === "EMERGENCY"
                ? tr("평가손실이 증거금의 90%에 닿아 {symbols} 포지션을 시장가로 청산합니다", {
                    symbols: Array.isArray(data.symbols) ? data.symbols.map((key: unknown) => positionKeyLabel(String(key), tr)).join(", ") : "",
                  })
                : tr("추가증거금 기한이 지나 포지션 일부를 시장가로 청산합니다"),
          });
        }
        return;
      }
      if (data.type === "bracket" && data.status === "ARMED") {
        push({
          id: `bracket:${data.id}`,
          href: `/symbol/${data.symbol}`,
          tone: "info",
          title: tr("{symbol} 손절/익절 자동 등록", { symbol: data.symbol }),
          detail: tr("체결 {n}주 · 평균 {price} · {note}", {
            n: fmt.format(Number(data.qty)),
            price: won(Number(data.avgFillPrice)),
            note: serverText(String(data.note ?? "")),
          }),
        });
        return;
      }
      if (data.type === "conditional" && typeof data.label === "string") {
        const symbol = String(data.symbol ?? "");
        const future = isFuture(symbol);
        const href = future ? `/futures/${symbol}` : `/symbol/${symbol}`;
        if (data.status === "TRIGGERED") {
          const price = future ? fmtFuture(symbol, Number(data.triggerPrice)) : won(Number(data.triggerPrice));
          push({
            id: `cond:${data.id}`,
            href,
            tone: "info",
            title: tr("{symbol} {label} 발동", { symbol: data.symbol, label: tr(data.label) }),
            detail: tr(future ? "{price} 도달 · {n}계약 시장가 접수" : "{price} 도달 · {n}주 시장가 접수", {
              price,
              n: fmt.format(Number(data.qty)),
            }),
          });
        } else if (data.status === "FAILED") {
          push({
            id: `cond:${data.id}`,
            href,
            tone: "warn",
            title: tr("{symbol} {label} 발동했지만 접수 실패", { symbol: data.symbol, label: tr(data.label) }),
            detail: data.failReason ? serverText(String(data.failReason)) : tr("사유 없음"),
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
