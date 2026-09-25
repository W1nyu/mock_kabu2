"use client";

import { futureDef, futureMarginPerContract, MAX_FUTURES_ORDER_QTY } from "@mock-kabu/shared";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { api, getUser, newIdempotencyKey } from "@/lib/api";
import { fmtFuture, krw, toFutureUnits, unitsToInput } from "@/lib/futures";

interface AccountInfo {
  available: number;
}

/**
 * 선물 주문 — 매수(롱)/매도(숏), 지정가/시장가, 계약 수. 필요 위탁증거금을 미리 보여 준다.
 * 신규·청산 구분 없이 주문 증거금을 묶고, 체결되면 포지션 증거금으로 바뀐다(청산분은 풀린다).
 */
export default function FuturesOrderPanel({
  symbol,
  lastPrice,
  priceHint,
  onPlaced,
  initialSide = "BUY",
}: {
  symbol: string;
  lastPrice: number | null;
  priceHint: { price: number; seq: number } | null;
  onPlaced: () => void;
  initialSide?: "BUY" | "SELL";
}) {
  const def = futureDef(symbol)!;
  const [side, setSide] = useState<"BUY" | "SELL">(initialSide);
  const [type, setType] = useState<"LIMIT" | "MARKET">("LIMIT");
  const [priceText, setPriceText] = useState("");
  const [qty, setQty] = useState(1);
  const [available, setAvailable] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  // 로그인 여부는 마운트 뒤에 읽는다 — 서버 렌더와 첫 클라이언트 렌더를 같게 둬 hydration 불일치를 막는다.
  const [loggedIn, setLoggedIn] = useState<boolean | null>(null);
  useEffect(() => setLoggedIn(getUser() != null), []);

  useEffect(() => {
    if (!priceText && lastPrice != null) setPriceText(unitsToInput(symbol, lastPrice));
  }, [lastPrice, priceText, symbol]);

  useEffect(() => {
    if (priceHint) setPriceText(unitsToInput(symbol, priceHint.price));
  }, [priceHint, symbol]);

  const refreshAccount = () => {
    if (!getUser()) return;
    api<AccountInfo>("/account").then((a) => setAvailable(a.available)).catch(() => {});
  };
  useEffect(refreshAccount, []);

  const priceUnits = type === "LIMIT" ? toFutureUnits(symbol, priceText) : lastPrice;
  const margin = useMemo(
    () => (priceUnits != null ? Number(futureMarginPerContract(def, priceUnits)) * qty : null),
    [def, priceUnits, qty],
  );
  const tickText = unitsToInput(symbol, def.tickUnits);
  const invalidPrice = type === "LIMIT" && priceUnits == null;

  async function submit() {
    if (invalidPrice) return;
    setBusy(true);
    setMessage(null);
    try {
      await api("/orders", {
        method: "POST",
        headers: { "idempotency-key": newIdempotencyKey() },
        body: { symbol, side, type, qty, ...(type === "LIMIT" ? { price: priceUnits } : {}) },
      });
      setMessage({ ok: true, text: `${side === "BUY" ? "매수" : "매도"} ${qty}계약 주문을 접수했습니다` });
      refreshAccount();
      onPlaced();
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : "주문에 실패했습니다" });
    } finally {
      setBusy(false);
    }
  }

  if (loggedIn === null) return <div className="glass min-h-[320px]" aria-busy />;
  if (!loggedIn) {
    return (
      <div className="glass p-4 text-sm text-ink-muted">
        선물 주문은 <Link href="/login" className="text-sky">로그인</Link> 후 이용할 수 있습니다.
      </div>
    );
  }

  const sideTone = side === "BUY" ? "bg-up text-white" : "bg-down text-white";
  return (
    <div className="glass space-y-3 p-4">
      <div className="grid grid-cols-2 gap-1 rounded-xl bg-surface-2/60 p-1">
        {(["BUY", "SELL"] as const).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setSide(s)}
            className={`min-h-10 rounded-lg text-sm font-semibold transition-colors ${
              side === s ? (s === "BUY" ? "bg-up/15 text-up" : "bg-down/15 text-down") : "text-ink-muted"
            }`}
          >
            {s === "BUY" ? "매수 (롱)" : "매도 (숏)"}
          </button>
        ))}
      </div>

      <div className="flex gap-1">
        {(["LIMIT", "MARKET"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setType(t)}
            className={`min-h-8 rounded-full px-3 text-[13px] font-medium ${
              type === t ? "bg-sky/12 text-sky ring-1 ring-sky/30 ring-inset" : "text-ink-muted"
            }`}
          >
            {t === "LIMIT" ? "지정가" : "시장가"}
          </button>
        ))}
      </div>

      {type === "LIMIT" && (
        <label className="block">
          <span className="text-xs text-ink-muted">가격 ({def.unit}, 호가 단위 {tickText})</span>
          <input
            inputMode="decimal"
            value={priceText}
            onChange={(e) => setPriceText(e.target.value)}
            className={`num mt-1 w-full rounded-lg border bg-surface-2/60 px-3 py-2 text-right ${
              invalidPrice ? "border-down/60" : "border-hairline"
            }`}
          />
        </label>
      )}

      <label className="block">
        <span className="text-xs text-ink-muted">수량 (계약)</span>
        <div className="mt-1 flex items-center gap-2">
          <button type="button" className="btn btn-ghost min-h-10 min-w-10" onClick={() => setQty((q) => Math.max(1, q - 1))}>
            −
          </button>
          <input
            inputMode="numeric"
            value={qty}
            onChange={(e) => setQty(Math.max(1, Math.min(MAX_FUTURES_ORDER_QTY, Number(e.target.value.replace(/\D/g, "")) || 1)))}
            className="num w-full rounded-lg border border-hairline bg-surface-2/60 px-3 py-2 text-center"
          />
          <button type="button" className="btn btn-ghost min-h-10 min-w-10" onClick={() => setQty((q) => Math.min(MAX_FUTURES_ORDER_QTY, q + 1))}>
            +
          </button>
        </div>
      </label>

      <dl className="num space-y-1 text-[13px]">
        <div className="flex justify-between">
          <dt className="text-ink-muted">필요 증거금 (위탁 {(def.initialMarginBps / 100).toFixed(2)}%)</dt>
          <dd className="font-semibold">{margin == null ? "—" : krw(margin)}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-ink-muted">주문 가능 금액</dt>
          <dd>{available == null ? "—" : krw(available)}</dd>
        </div>
        {type === "MARKET" && (
          <div className="flex justify-between text-ink-faint">
            <dt>현재가</dt>
            <dd>{fmtFuture(symbol, lastPrice)}</dd>
          </div>
        )}
      </dl>

      <button
        type="button"
        disabled={busy || invalidPrice}
        onClick={submit}
        className={`min-h-11 w-full rounded-xl text-sm font-semibold disabled:opacity-50 ${sideTone}`}
      >
        {busy ? "주문 중…" : `${side === "BUY" ? "매수" : "매도"} ${qty}계약`}
      </button>
      {message && <p className={`text-[13px] ${message.ok ? "text-ok" : "text-down"}`}>{message.text}</p>}
      <p className="text-[11px] leading-5 text-ink-faint">
        1일물 — 매일 04:10 점검 시간에 그 시각 기초자산 가격으로 현금 정산되고 포지션이 사라집니다.
      </p>
    </div>
  );
}
