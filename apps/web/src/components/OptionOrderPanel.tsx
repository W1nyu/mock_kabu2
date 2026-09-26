"use client";

import { MAX_FUTURES_ORDER_QTY, optionDef } from "@mock-kabu/shared";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api, getUser, newIdempotencyKey } from "@/lib/api";
import { krw } from "@/lib/futures";
import { fmtOption, type OptionPosition } from "@/lib/options";

/** 입력한 가격(실제값) → 정수 단위, 호가 단위에 맞지 않으면 null */
function toUnits(symbol: string, text: string): number | null {
  const def = optionDef(symbol);
  const value = Number(text.replace(/,/g, ""));
  if (!def || !Number.isFinite(value) || value <= 0) return null;
  const units = Math.round(value * def.priceScale);
  return units % def.tickUnits === 0 ? units : null;
}

function toInput(symbol: string, units: number): string {
  const def = optionDef(symbol);
  return def ? (units / def.priceScale).toFixed(def.decimals) : String(units);
}

/**
 * 옵션 주문 — 매수, 또는 보유 수량 이내의 매도(청산). 매수는 프리미엄(가격 × 승수 × 계약)을 현금으로 낸다.
 * 옵션 쓰기(보유 없이 매도)는 할 수 없다.
 */
export default function OptionOrderPanel({
  symbol,
  lastPrice,
  position,
  available,
  priceHint,
  onPlaced,
  retired = false,
}: {
  /** 거래 종료 — 매수 불가, 보유분 매도만 */
  retired?: boolean;
  symbol: string;
  lastPrice: number | null;
  position: OptionPosition | null;
  available: number | null;
  priceHint: { price: number; seq: number } | null;
  onPlaced: () => void;
}) {
  const def = optionDef(symbol)!;
  const held = Math.max(0, position?.qty ?? 0);
  const [side, setSide] = useState<"BUY" | "SELL">(retired ? "SELL" : "BUY");
  const [type, setType] = useState<"LIMIT" | "MARKET">("LIMIT");
  const [priceText, setPriceText] = useState("");
  const [qty, setQty] = useState(1);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [loggedIn, setLoggedIn] = useState<boolean | null>(null);
  useEffect(() => setLoggedIn(getUser() != null), []);

  useEffect(() => {
    if (!priceText && lastPrice != null) setPriceText(toInput(symbol, lastPrice));
  }, [lastPrice, priceText, symbol]);
  useEffect(() => {
    if (priceHint) setPriceText(toInput(symbol, priceHint.price));
  }, [priceHint, symbol]);
  // 보유가 없으면 매도 칸을 쓸 수 없다.
  useEffect(() => {
    if (held === 0 && side === "SELL" && !retired) setSide("BUY");
    if (retired && side === "BUY") setSide("SELL");
  }, [held, side, retired]);

  const maxQty = side === "SELL" ? Math.min(held, MAX_FUTURES_ORDER_QTY) : MAX_FUTURES_ORDER_QTY;
  const priceUnits = type === "LIMIT" ? toUnits(symbol, priceText) : lastPrice;
  const invalidPrice = type === "LIMIT" && priceUnits == null;
  // 서버가 매수에 묶는 금액: 지정가는 그 가격, 시장가는 최근가 × 1.5 + 10호가(체결 상한)
  const holdUnits = type === "LIMIT" ? priceUnits : lastPrice != null ? Math.ceil(lastPrice * 1.5) + def.tickUnits * 10 : null;
  const premium = priceUnits != null ? priceUnits * def.unitValue * qty : null;
  const hold = holdUnits != null ? holdUnits * def.unitValue * qty : null;

  function stepPrice(direction: 1 | -1) {
    const base = toUnits(symbol, priceText) ?? lastPrice;
    if (base == null) return;
    const snapped = Math.round(base / def.tickUnits) * def.tickUnits;
    setPriceText(toInput(symbol, Math.max(def.tickUnits, snapped + direction * def.tickUnits)));
  }

  async function submit() {
    if (invalidPrice || qty < 1 || qty > maxQty) return;
    setBusy(true);
    setMessage(null);
    try {
      await api("/orders", {
        method: "POST",
        headers: { "idempotency-key": newIdempotencyKey() },
        body: { symbol, side, type, qty, ...(type === "LIMIT" ? { price: priceUnits } : {}) },
      });
      setMessage({ ok: true, text: `${side === "BUY" ? "매수" : "매도"} ${qty}계약 주문을 접수했습니다` });
      onPlaced();
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : "주문에 실패했습니다" });
    } finally {
      setBusy(false);
    }
  }

  if (loggedIn === null) return <div className="glass min-h-[280px]" aria-busy />;
  if (!loggedIn) {
    return (
      <div className="glass p-4 text-sm text-ink-muted">
        옵션 주문은{" "}
        <Link href="/login" className="text-sky">
          로그인
        </Link>{" "}
        후 이용할 수 있습니다.
      </div>
    );
  }

  return (
    <div className="glass space-y-3 p-4">
      <div className="grid grid-cols-2 gap-1 rounded-xl bg-surface-2/60 p-1">
        {(["BUY", "SELL"] as const).map((s) => (
          <button
            key={s}
            type="button"
            disabled={(s === "SELL" && held === 0) || (s === "BUY" && retired)}
            onClick={() => {
              setSide(s);
              if (s === "SELL") setQty((q) => Math.min(Math.max(1, q), held));
            }}
            className={`min-h-10 rounded-lg text-sm font-semibold transition-colors disabled:opacity-40 ${
              side === s ? (s === "BUY" ? "bg-up/15 text-up" : "bg-down/15 text-down") : "text-ink-muted"
            }`}
          >
            {s === "BUY" ? "매수" : `매도 (보유 ${held})`}
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
          <span className="text-xs text-ink-muted">
            가격 ({def.unit}, 호가 단위 {toInput(symbol, def.tickUnits)})
          </span>
          <div className="mt-1 flex items-center gap-2">
            <button type="button" className="btn btn-ghost min-h-10 min-w-10" aria-label="호가 한 단계 내리기" onClick={() => stepPrice(-1)}>
              −
            </button>
            <input
              inputMode="decimal"
              value={priceText}
              onChange={(e) => setPriceText(e.target.value)}
              className={`num w-full rounded-lg border bg-surface-2/60 px-3 py-2 text-right ${invalidPrice ? "border-down/60" : "border-hairline"}`}
            />
            <button type="button" className="btn btn-ghost min-h-10 min-w-10" aria-label="호가 한 단계 올리기" onClick={() => stepPrice(1)}>
              +
            </button>
          </div>
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
            onChange={(e) => setQty(Math.max(1, Math.min(maxQty || 1, Number(e.target.value.replace(/\D/g, "")) || 1)))}
            className="num w-full rounded-lg border border-hairline bg-surface-2/60 px-3 py-2 text-center"
          />
          <button type="button" className="btn btn-ghost min-h-10 min-w-10" onClick={() => setQty((q) => Math.min(maxQty || 1, q + 1))}>
            +
          </button>
        </div>
      </label>

      <dl className="num space-y-1 text-[13px]">
        <div className="flex justify-between">
          <dt className="text-ink-muted">{side === "BUY" ? "프리미엄 (낼 금액)" : "프리미엄 (받을 금액)"}</dt>
          <dd className="font-semibold">{premium == null ? "—" : `${type === "MARKET" ? "약 " : ""}${krw(premium)}`}</dd>
        </div>
        {side === "BUY" && type === "MARKET" && (
          <div className="flex justify-between text-ink-faint">
            <dt>주문 때 묶는 금액 (체결 상한)</dt>
            <dd>{hold == null ? "—" : krw(hold)}</dd>
          </div>
        )}
        <div className="flex justify-between">
          <dt className="text-ink-muted">주문 가능 금액</dt>
          <dd>{available == null ? "—" : krw(available)}</dd>
        </div>
        {type === "MARKET" && (
          <div className="flex justify-between text-ink-faint">
            <dt>현재가</dt>
            <dd>{fmtOption(symbol, lastPrice)}</dd>
          </div>
        )}
      </dl>

      <button
        type="button"
        disabled={busy || invalidPrice || (side === "SELL" && held === 0) || (side === "BUY" && retired)}
        onClick={submit}
        className={`min-h-11 w-full rounded-xl text-sm font-semibold text-white disabled:opacity-50 ${side === "BUY" ? "bg-up" : "bg-down"}`}
      >
        {busy ? "주문 중…" : `${side === "BUY" ? "매수" : "매도"} ${qty}계약`}
      </button>
      {message && <p className={`text-[13px] ${message.ok ? "text-ok" : "text-down"}`}>{message.text}</p>}
      <p className="text-[11px] leading-5 text-ink-faint">
        1계약 = 가격 1{def.unit === "원" ? "원" : "pt"} × {(def.unitValue * def.priceScale).toLocaleString("ko-KR")}원. 최대 손실은 낸
        프리미엄까지입니다.
      </p>
    </div>
  );
}
