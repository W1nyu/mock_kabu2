"use client";

import { MARKET_BUY_HOLD_FACTOR } from "@mock-kabu/shared";
import { useEffect, useState } from "react";
import { api, fmt, getUser, won } from "@/lib/api";
import { subscribe } from "@/lib/socket";

interface AccountInfo {
  balance: number;
  holdAmount: number;
  available: number;
}
interface HoldingRow {
  symbol: string;
  qty: number;
  holdQty: number;
  availableQty: number;
}

export default function OrderForm({
  symbol,
  priceHint,
  lastPrice,
  onPlaced,
}: {
  symbol: string;
  priceHint: number | null;
  lastPrice: number | null;
  onPlaced?: () => void;
}) {
  const [side, setSide] = useState<"BUY" | "SELL">("BUY");
  const [type, setType] = useState<"LIMIT" | "MARKET">("LIMIT");
  const [price, setPrice] = useState("");
  const [qty, setQty] = useState("");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [account, setAccount] = useState<AccountInfo | null>(null);
  const [holding, setHolding] = useState<HoldingRow | null>(null);
  const [activePct, setActivePct] = useState<number | null>(null);
  const [sizingNote, setSizingNote] = useState<string | null>(null);
  const availableQty = holding?.availableQty ?? 0;

  useEffect(() => {
    if (priceHint != null) {
      setPrice(String(priceHint));
      setActivePct(null);
      setSizingNote(null);
    }
  }, [priceHint]);

  function refreshLimits() {
    api<AccountInfo>("/account").then(setAccount).catch(() => {});
    api<HoldingRow[]>("/account/holdings")
      .then((rows) => setHolding(rows.find((h) => h.symbol === symbol) ?? null))
      .catch(() => {});
  }

  useEffect(() => {
    // 종목 전환 직후 이전 종목의 매도 가능 수량이 잠시 보이지 않게 한다.
    setHolding(null);
    refreshLimits();
    // account:{id} push가 주 갱신 경로, 폴링은 push 유실 대비 fallback
    const t = setInterval(refreshLimits, 15000);
    const user = getUser();
    const unsub = user ? subscribe([`account:${user.accountId}`], () => refreshLimits()) : () => {};
    return () => {
      clearInterval(t);
      unsub();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol]);

  // 잔액이나 보유 수량이 바뀌면 이전 비율 선택 표시가 더는 정확하지 않다.
  useEffect(() => {
    setActivePct(null);
  }, [account?.available, availableQty]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      await api("/orders", {
        method: "POST",
        body: {
          symbol,
          side,
          type,
          qty: Number(qty),
          ...(type === "LIMIT" ? { price: Number(price) } : {}),
        },
      });
      setMessage({ ok: true, text: "주문이 접수되었습니다" });
      setQty("");
      resetSizing();
      refreshLimits();
      onPlaced?.();
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : "주문 실패" });
    } finally {
      setBusy(false);
    }
  }

  const parsedQty = Number(qty);
  const validQty = Number.isSafeInteger(parsedQty) && parsedQty > 0;
  const parsedLimitPrice = Number(price);
  const limitPrice =
    Number.isSafeInteger(parsedLimitPrice) && parsedLimitPrice > 0 ? parsedLimitPrice : null;

  // % 버튼의 매수 기준가 — 시장가는 ceil(최근가*110%)*수량이 홀드되므로(order.service) 같은 기준이어야 거부되지 않음
  const buyRefPrice =
    type === "LIMIT"
      ? limitPrice
      : lastPrice != null && lastPrice > 0
        ? Math.ceil(lastPrice * MARKET_BUY_HOLD_FACTOR)
        : null;
  const estimatePrice = side === "BUY" ? buyRefPrice : type === "LIMIT" ? limitPrice : null;
  const estimate = validQty && estimatePrice != null ? estimatePrice * parsedQty : null;
  const maxBuyQty =
    buyRefPrice != null && account != null ? Math.floor(account.available / buyRefPrice) : null;
  const pctDisabled = side === "BUY" ? buyRefPrice == null || buyRefPrice <= 0 : availableQty <= 0;
  const exceedsAvailableCash =
    side === "BUY" && estimate != null && account != null && estimate > account.available;
  const exceedsAvailableShares = side === "SELL" && validQty && parsedQty > availableQty;

  function applyPct(pct: number) {
    let computed = 0;
    if (side === "SELL") {
      computed = Math.floor(availableQty * pct);
    } else if (buyRefPrice != null && buyRefPrice > 0) {
      computed = Math.floor(((account?.available ?? 0) * pct) / buyRefPrice);
    }
    if (computed <= 0) {
      setQty("");
      setActivePct(null);
      setSizingNote(
        side === "BUY"
          ? "주문 가능 현금으로는 현재 기준가의 1주를 매수할 수 없습니다."
          : "매도 가능한 보유 수량이 없습니다.",
      );
      return;
    }
    setQty(String(computed));
    setActivePct(pct);
    setSizingNote(null);
  }

  function resetSizing() {
    setActivePct(null);
    setSizingNote(null);
  }

  return (
    <form onSubmit={submit} className="rounded-lg border border-neutral-800 bg-neutral-900 p-4">
      <div className="mb-3 grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => {
            setSide("BUY");
            resetSizing();
          }}
          className={`rounded py-2 text-sm font-bold ${side === "BUY" ? "bg-red-500/90 text-white" : "bg-neutral-800 text-neutral-400"}`}
        >
          매수
        </button>
        <button
          type="button"
          onClick={() => {
            setSide("SELL");
            resetSizing();
          }}
          className={`rounded py-2 text-sm font-bold ${side === "SELL" ? "bg-blue-500/90 text-white" : "bg-neutral-800 text-neutral-400"}`}
        >
          매도
        </button>
      </div>

      <div className="mb-3 flex gap-3 text-sm">
        {(["LIMIT", "MARKET"] as const).map((t) => (
          <label key={t} className="flex items-center gap-1.5">
            <input
              type="radio"
              checked={type === t}
              onChange={() => {
                setType(t);
                resetSizing();
              }}
            />
            {t === "LIMIT" ? "지정가" : "시장가"}
          </label>
        ))}
      </div>

      {type === "LIMIT" && (
        <label className="mb-2 block text-sm">
          <span className="text-neutral-400">가격</span>
          <input
            className="mt-1 w-full rounded border border-neutral-700 bg-neutral-950 px-3 py-2 tabular-nums"
            inputMode="numeric"
            value={price}
            onChange={(e) => {
              setPrice(e.target.value.replace(/[^0-9]/g, ""));
              resetSizing();
            }}
            placeholder="호가를 클릭해도 입력됩니다"
          />
        </label>
      )}

      <label className="mb-2 block text-sm">
        <span className="text-neutral-400">수량</span>
        <input
          className="mt-1 w-full rounded border border-neutral-700 bg-neutral-950 px-3 py-2 tabular-nums"
          inputMode="numeric"
          value={qty}
          onChange={(e) => {
            setQty(e.target.value.replace(/[^0-9]/g, ""));
            resetSizing();
          }}
        />
      </label>

      <div className="mb-2">
        <div className="mb-1 flex items-center justify-between text-[11px] text-neutral-500">
          <span>{side === "BUY" ? "주문 가능 현금 기준" : "매도 가능 수량 기준"}</span>
          {side === "BUY" && buyRefPrice != null && (
            <span className="tabular-nums">
              {type === "MARKET" ? "최근가 110%" : "지정가"} {won(buyRefPrice)}
            </span>
          )}
        </div>
        <div className="grid grid-cols-4 gap-1.5">
          {([0.1, 0.25, 0.5, 1] as const).map((pct) => (
            <button
              key={pct}
              type="button"
              disabled={pctDisabled}
              onClick={() => applyPct(pct)}
              aria-pressed={activePct === pct}
              title={
                side === "BUY"
                  ? type === "LIMIT"
                    ? "주문 가능 현금 대비 (가격 입력 필요)"
                    : "주문 가능 현금 대비 (최근가 110% 기준)"
                  : "매도 가능 수량 대비"
              }
              className={`rounded py-1 text-xs tabular-nums transition-colors disabled:opacity-40 ${
                activePct === pct
                  ? side === "BUY"
                    ? "bg-red-500/20 text-red-300 ring-1 ring-inset ring-red-500/60"
                    : "bg-blue-500/20 text-blue-300 ring-1 ring-inset ring-blue-500/60"
                  : "bg-neutral-800 text-neutral-400 hover:bg-neutral-700 hover:text-neutral-200"
              }`}
            >
              {pct === 1 ? "최대" : `${pct * 100}%`}
            </button>
          ))}
        </div>
      </div>

      <div className="mb-3 space-y-0.5 text-xs text-neutral-400 tabular-nums">
        {side === "BUY" ? (
          <>
            <p>
              주문 가능 현금: <span className="text-neutral-200">{account ? won(account.available) : "불러오는 중"}</span>
            </p>
            {account && (
              <p className="text-neutral-500">
                예수금 {won(account.balance)}
                {account.holdAmount > 0 && ` · 주문 대기 ${won(account.holdAmount)} 제외`}
              </p>
            )}
            {maxBuyQty != null && (
              <p className="text-neutral-500">현재 기준 최대 {fmt.format(maxBuyQty)}주 매수 가능</p>
            )}
          </>
        ) : (
          <>
            <p>
              매도 가능 수량: <span className="text-neutral-200">{fmt.format(availableQty)}주</span>
            </p>
            <p className="text-neutral-500">
              보유 {fmt.format(holding?.qty ?? 0)}주
              {holding && holding.holdQty > 0 && ` · 매도 대기 ${fmt.format(holding.holdQty)}주 제외`}
            </p>
          </>
        )}
        {estimate != null && (
          <p>
            {side === "BUY" && type === "MARKET" ? "예상 최대 홀드 금액" : "예상 주문금액"}: {won(estimate)}
          </p>
        )}
        {type === "MARKET" && side === "BUY" && (
          <p>시장가 매수는 최근가의 110%까지 증거금이 홀드됩니다</p>
        )}
        {sizingNote && <p className="text-amber-400">{sizingNote}</p>}
        {exceedsAvailableCash && (
          <p className="text-amber-400">입력 수량이 현재 주문 가능 현금을 초과합니다. 접수 시 다시 확인됩니다.</p>
        )}
        {exceedsAvailableShares && (
          <p className="text-amber-400">입력 수량이 현재 매도 가능 수량을 초과합니다. 접수 시 다시 확인됩니다.</p>
        )}
      </div>

      {message && (
        <p className={`mb-2 text-sm ${message.ok ? "text-emerald-400" : "text-red-400"}`}>
          {message.text}
        </p>
      )}

      <button
        disabled={busy || !validQty || (type === "LIMIT" && limitPrice == null)}
        className={`w-full rounded py-2 font-bold text-white disabled:opacity-40 ${side === "BUY" ? "bg-red-500 hover:bg-red-400" : "bg-blue-500 hover:bg-blue-400"}`}
      >
        {side === "BUY" ? "매수" : "매도"} 주문
      </button>
    </form>
  );
}
