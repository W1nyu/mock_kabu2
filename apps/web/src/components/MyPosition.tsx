"use client";

import type { ConditionalOrderDto } from "@mock-kabu/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, fmt, getUser, won } from "@/lib/api";
import { ACCOUNT_REFRESH_DEBOUNCE_MS, debounce } from "@/lib/debounce";
import { guardSummary } from "@/lib/guards";
import { subscribe } from "@/lib/socket";

interface HoldingRow {
  symbol: string;
  qty: number;
  holdQty: number;
  availableQty: number;
  lastPrice: number;
  costBasis: number;
  avgCost: number;
}

interface RealizedSummary {
  bySymbol: {
    symbol: string;
    realized: number;
    qty: number;
    realizedRate: number | null;
  }[];
}

/** 해당 종목 보유 포지션 요약 — 평단가·실시간 수익률·청산. 포지션이 없으면 렌더하지 않음 */
export default function MyPosition({
  symbol,
  onProtected,
}: {
  symbol: string;
  /** OCO 보호 주문이 등록된 직후 호출 — 예약 주문 목록을 즉시 갱신하는 데 쓴다 */
  onProtected?: () => void;
}) {
  const [holding, setHolding] = useState<HoldingRow | null>(null);
  const [protecting, setProtecting] = useState(false);
  const [stopPrice, setStopPrice] = useState("");
  const [takePrice, setTakePrice] = useState("");
  const [protectQty, setProtectQty] = useState("");
  const [protectBusy, setProtectBusy] = useState(false);
  const [protectError, setProtectError] = useState<string | null>(null);
  /** 이 종목에 걸려 있는 대기 중 매도 예약 — 포지션이 어떤 보호를 받고 있는지 한 줄로 보여준다 */
  const [guards, setGuards] = useState<ConditionalOrderDto[]>([]);
  const [realized, setRealized] = useState<number | null>(null);
  const [livePrice, setLivePrice] = useState<number | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(() => {
    api<HoldingRow[]>("/account/holdings")
      .then((rows) => setHolding(rows.find((h) => h.symbol === symbol && h.qty > 0) ?? null))
      .catch(() => {});
    api<RealizedSummary>("/account/realized?limit=1")
      .then((summary) => {
        const row = summary.bySymbol.find((entry) => entry.symbol === symbol);
        setRealized(row && row.qty > 0 ? row.realized : null);
      })
      .catch(() => {});
    api<ConditionalOrderDto[]>(`/orders/conditional?symbol=${symbol}&status=WAITING&limit=20`)
      .then((rows) => setGuards(rows.filter((row) => row.side === "SELL")))
      .catch(() => {});
  }, [symbol]);

  useEffect(() => {
    setHolding(null);
    setRealized(null);
    setLivePrice(null);
    setConfirming(false);
    setMessage(null);
    setProtecting(false);
    setProtectError(null);
    setGuards([]);
    refresh();
    const t = setInterval(refresh, 5000);
    const user = getUser();
    const refreshSoon = debounce(refresh, ACCOUNT_REFRESH_DEBOUNCE_MS);
    const unsubAccount = user
      ? subscribe([`account:${user.accountId}`], () => refreshSoon())
      : () => {};
    const unsubTrades = subscribe([`trades:${symbol}`], ({ data }) => {
      if (Number.isFinite(data?.price)) setLivePrice(data.price);
    });
    return () => {
      clearInterval(t);
      unsubAccount();
      unsubTrades();
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
    };
  }, [symbol, refresh]);

  async function liquidate() {
    if (!holding || holding.availableQty <= 0) return;
    setBusy(true);
    setMessage(null);
    try {
      await api("/orders", {
        method: "POST",
        body: {
          symbol,
          side: "SELL",
          type: "MARKET",
          qty: holding.availableQty,
        },
      });
      setMessage(`청산 주문 접수: ${fmt.format(holding.availableQty)}주 시장가 매도`);
      refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "청산 실패");
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  function onLiquidateClick() {
    if (confirming) {
      void liquidate();
      return;
    }
    // 오클릭 방지: 첫 클릭은 확인 상태로만 전환, 4초 내 재클릭 시 실행
    setConfirming(true);
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    confirmTimer.current = setTimeout(() => setConfirming(false), 4000);
  }

  function openProtect() {
    if (!holding) return;
    const reference = livePrice ?? holding.lastPrice;
    // 기본값: 평단가 기준 −5% 손절 / +10% 익절. 현재가를 이미 넘긴 값은 서버가 거부하므로 안쪽으로 당긴다.
    const base = holding.avgCost > 0 ? holding.avgCost : reference;
    setStopPrice(String(Math.min(reference - 1, Math.round(base * 0.95))));
    setTakePrice(String(Math.max(reference + 1, Math.round(base * 1.1))));
    setProtectQty(String(holding.availableQty));
    setProtectError(null);
    setProtecting(true);
  }

  async function submitProtect(e: React.FormEvent) {
    e.preventDefault();
    if (!holding) return;
    setProtectBusy(true);
    setProtectError(null);
    try {
      await api("/orders/conditional/oco", {
        method: "POST",
        body: {
          symbol,
          side: "SELL",
          qty: Number(protectQty),
          lowerPrice: Number(stopPrice),
          upperPrice: Number(takePrice),
        },
      });
      setMessage(
        `손절 ${fmt.format(Number(stopPrice))} / 익절 ${fmt.format(Number(takePrice))} 예약 등록 (${fmt.format(Number(protectQty))}주)`,
      );
      setProtecting(false);
      refresh();
      onProtected?.();
    } catch (err) {
      setProtectError(err instanceof Error ? err.message : "예약 실패");
    } finally {
      setProtectBusy(false);
    }
  }

  if (!holding) return null;

  const price = livePrice ?? holding.lastPrice;
  const value = price * holding.qty;
  const pnl = value - holding.costBasis;
  const pnlRate = holding.costBasis > 0 ? pnl / holding.costBasis : 0;
  const pnlColor = pnl >= 0 ? "text-up" : "text-down";
  const sign = pnl >= 0 ? "+" : "";

  return (
    <div className="glass overflow-hidden">
      <div className="flex flex-wrap items-center gap-x-7 gap-y-3 px-5 py-3.5 text-sm">
        <span className="panel-title">내 포지션</span>
        <Item label="보유">
          {fmt.format(holding.qty)}주
          {holding.holdQty > 0 && (
            <span className="text-ink-faint"> (매도 대기 {fmt.format(holding.holdQty)})</span>
          )}
        </Item>
        <Item label="평단가">{fmt.format(Math.round(holding.avgCost))}</Item>
        <Item label="현재가">{fmt.format(price)}</Item>
        <Item label="평가손익">
          <span className={`font-semibold ${pnlColor}`}>
            {sign}
            {won(pnl)} ({sign}
            {(pnlRate * 100).toFixed(2)}%)
          </span>
        </Item>
        {guards.length > 0 && (
          <Item label="보호">
            <span className="text-ink-muted" title="이 종목에 대기 중인 매도 예약 주문">
              {guardSummary(guards)}
            </span>
          </Item>
        )}
        {realized != null && (
          <Item label="실현손익">
            <span
              className={`font-semibold ${realized > 0 ? "text-up" : realized < 0 ? "text-down" : ""}`}
              title="이 종목의 매도 체결에서 지금까지 확정된 손익 합계"
            >
              {realized > 0 ? "+" : ""}
              {won(realized)}
            </span>
          </Item>
        )}
        <div className="ml-auto flex items-center gap-3">
          {message && <span className="text-xs text-ink-muted">{message}</span>}
          <button
            type="button"
            onClick={() => (protecting ? setProtecting(false) : openProtect())}
            disabled={holding.availableQty <= 0}
            aria-pressed={protecting}
            title="손절가와 익절가를 한 쌍(OCO)으로 예약합니다. 한쪽이 발동하면 다른 쪽은 자동 취소됩니다"
            className="btn btn-ghost btn-sm"
          >
            {protecting ? "닫기" : "손절/익절 설정"}
          </button>
          <button
            onClick={onLiquidateClick}
            disabled={busy || holding.availableQty <= 0}
            title={
              holding.availableQty <= 0
                ? "매도 대기 중인 수량뿐이라 청산할 수 없습니다"
                : "보유 수량 전체를 시장가로 매도합니다"
            }
            className={`btn btn-sm ${
              confirming ? "btn-sell" : "border-down/50 bg-down/10 text-down hover:bg-down/16"
            }`}
          >
            {confirming ? `${fmt.format(holding.availableQty)}주 전량 매도 확인` : "포지션 청산"}
          </button>
        </div>
      </div>
      {protecting && (
        <form
          onSubmit={submitProtect}
          className="num flex flex-wrap items-end gap-3 border-t border-hairline-soft bg-surface-3/15 px-5 py-3 text-xs"
        >
          <ProtectField
            id={`protect-stop-${symbol}`}
            label="손절가 (이하면 매도)"
            value={stopPrice}
            onChange={setStopPrice}
            tone="down"
            hint={pctVsAvg(Number(stopPrice), holding.avgCost)}
          />
          <ProtectField
            id={`protect-take-${symbol}`}
            label="익절가 (이상이면 매도)"
            value={takePrice}
            onChange={setTakePrice}
            tone="up"
            hint={pctVsAvg(Number(takePrice), holding.avgCost)}
          />
          <ProtectField
            id={`protect-qty-${symbol}`}
            label={`수량 (최대 ${fmt.format(holding.availableQty)})`}
            value={protectQty}
            onChange={setProtectQty}
          />
          <button
            disabled={
              protectBusy ||
              !(Number(stopPrice) > 0) ||
              !(Number(takePrice) > 0) ||
              Number(stopPrice) >= Number(takePrice) ||
              !(Number(protectQty) > 0) ||
              Number(protectQty) > holding.availableQty
            }
            className="btn btn-primary btn-sm"
          >
            {protectBusy ? "등록 중…" : "OCO 예약"}
          </button>
          <span className="text-ink-faint">
            현재가 {fmt.format(price)} · 한쪽이 발동하면 다른 쪽은 자동 취소 · 대기 중 홀드 없음
          </span>
          {protectError && <span className="basis-full text-warn">{protectError}</span>}
        </form>
      )}
    </div>
  );
}

function pctVsAvg(target: number, avgCost: number): string | undefined {
  if (!(target > 0) || !(avgCost > 0)) return undefined;
  const pct = ((target - avgCost) / avgCost) * 100;
  return `평단 대비 ${pct > 0 ? "+" : ""}${pct.toFixed(1)}%`;
}

function ProtectField({
  id,
  label,
  value,
  onChange,
  tone,
  hint,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (next: string) => void;
  tone?: "up" | "down";
  hint?: string;
}) {
  const color = tone === "up" ? "text-up" : tone === "down" ? "text-down" : "text-ink-muted";
  return (
    <label htmlFor={id} className="flex flex-col gap-1">
      <span className={`text-[11px] ${color}`}>{label}</span>
      <input
        id={id}
        className="field num w-36 py-1.5 text-xs"
        inputMode="numeric"
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/[^0-9]/g, ""))}
      />
      <span className="h-3 text-[10px] text-ink-faint">{hint ?? ""}</span>
    </label>
  );
}

function Item({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <span className="num">
      <span className="mr-1.5 text-xs text-ink-faint">{label}</span>
      {children}
    </span>
  );
}
