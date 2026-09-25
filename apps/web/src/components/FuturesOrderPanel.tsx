"use client";

import { futureDef, futureMarginPerContract, MARKET_BUY_HOLD_FACTOR, MAX_FUTURES_ORDER_QTY } from "@mock-kabu/shared";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api, getUser, newIdempotencyKey } from "@/lib/api";
import { everyVisible } from "@/lib/visible-interval";
import { fmtFuture, krw, LEVERAGE_CHOICES, leverageLabel, toFutureUnits, unitsToInput, type FuturesAccount } from "@/lib/futures";

interface AccountInfo {
  available: number;
}

/**
 * 선물 주문 — 레버리지(1~20배), 매수(롱)/매도(숏), 지정가/시장가, 계약 수. 필요 위탁증거금을 미리 보여 준다.
 * 신규 주문은 레버리지로 계산한 증거금을 묶고, 보유 포지션을 줄이는 청산 주문은 증거금이 필요 없다.
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
  const [futures, setFutures] = useState<FuturesAccount | null>(null);
  const [liveOrders, setLiveOrders] = useState(0);
  const [leverageBusy, setLeverageBusy] = useState(false);
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

  const refreshAccount = useCallback(() => {
    if (!getUser()) return;
    api<AccountInfo>("/account")
      .then((a) => setAvailable(a.available))
      .catch(() => {});
    api<FuturesAccount>("/account/futures")
      .then(setFutures)
      .catch(() => {});
    api<unknown[]>(`/orders?symbol=${symbol}&status=live&limit=50`)
      .then((rows) => setLiveOrders(rows.length))
      .catch(() => {});
  }, [symbol]);
  // 체결·청산으로 포지션·미체결이 바뀌면 레버리지 잠금과 청산 판정이 달라진다 — 10초마다(보일 때) 다시 읽는다.
  useEffect(() => {
    refreshAccount();
    return everyVisible(refreshAccount, 10_000);
  }, [refreshAccount]);

  const leverage = futures?.leverage?.[symbol] ?? null;
  const positionQty = futures?.positions.find((p) => p.symbol === symbol)?.qty ?? 0;
  // 포지션·미체결이 있으면 레버리지를 못 바꾼다(서버도 막는다).
  const leverageLocked = positionQty !== 0 || liveOrders > 0;
  const closing = (side === "SELL" && positionQty > 0) || (side === "BUY" && positionQty < 0);
  const closingOnly = closing && qty <= Math.abs(positionQty);

  async function chooseLeverage(next: number | null) {
    setLeverageBusy(true);
    setMessage(null);
    try {
      await api("/account/futures/leverage", { method: "POST", body: { symbol, leverage: next } });
      refreshAccount();
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : "레버리지를 바꾸지 못했습니다" });
    } finally {
      setLeverageBusy(false);
    }
  }

  const priceUnits = type === "LIMIT" ? toFutureUnits(symbol, priceText) : lastPrice;
  // 서버가 증거금을 잡는 가격: 지정가는 그 가격, 시장가는 최근가 × 1.1(체결 상한)
  const holdPriceUnits = type === "LIMIT" ? priceUnits : lastPrice != null ? Math.ceil(lastPrice * MARKET_BUY_HOLD_FACTOR) : null;
  const perContract = holdPriceUnits != null ? Number(futureMarginPerContract(def, holdPriceUnits, leverage)) : null;
  // 수량 % 버튼의 기준: 청산 방향이면 보유 포지션, 아니면 주문 가능 금액으로 열 수 있는 최대 계약
  const sizingBase = closing
    ? Math.min(Math.abs(positionQty), MAX_FUTURES_ORDER_QTY)
    : available != null && perContract != null && perContract > 0
      ? Math.min(MAX_FUTURES_ORDER_QTY, Math.floor(available / perContract))
      : 0;
  const [activePct, setActivePct] = useState<number | null>(null);
  function applyPct(pct: number) {
    if (sizingBase < 1) return;
    setQty(Math.max(1, Math.floor(sizingBase * pct)));
    setActivePct(pct);
  }
  const margin = perContract != null ? perContract * qty : null;
  const tickText = unitsToInput(symbol, def.tickUnits);
  /** 지정가를 호가 단위만큼 올리고 내린다(입력이 비었거나 틀렸으면 현재가에서 시작, 틱에 맞춘다). */
  function stepPrice(direction: 1 | -1) {
    const base = toFutureUnits(symbol, priceText) ?? lastPrice;
    if (base == null) return;
    const snapped = Math.round(base / def.tickUnits) * def.tickUnits;
    setPriceText(unitsToInput(symbol, Math.max(def.tickUnits, snapped + direction * def.tickUnits)));
  }
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
        선물 주문은{" "}
        <Link href="/login" className="text-sky">
          로그인
        </Link>{" "}
        후 이용할 수 있습니다.
      </div>
    );
  }

  const sideTone = side === "BUY" ? "bg-up text-white" : "bg-down text-white";
  return (
    <div className="glass space-y-3 p-4">
      <div>
        <div className="flex items-center justify-between text-xs text-ink-muted">
          <span>레버리지</span>
          <span className="num font-semibold text-ink">{leverageLabel(symbol, leverage)}</span>
        </div>
        <div className="mt-1.5 flex flex-wrap gap-1" role="group" aria-label="레버리지">
          <button
            type="button"
            disabled={leverageLocked || leverageBusy}
            onClick={() => chooseLeverage(null)}
            aria-pressed={leverage == null}
            className={`num min-h-8 rounded-full px-2.5 text-[12px] font-medium disabled:opacity-50 ${
              leverage == null
                ? "bg-sky/12 text-sky ring-1 ring-sky/30 ring-inset"
                : "text-ink-muted ring-1 ring-hairline ring-inset"
            }`}
          >
            기본
          </button>
          {LEVERAGE_CHOICES.map((choice) => (
            <button
              key={choice}
              type="button"
              disabled={leverageLocked || leverageBusy}
              onClick={() => chooseLeverage(choice)}
              aria-pressed={leverage === choice}
              className={`num min-h-8 rounded-full px-2.5 text-[12px] font-medium disabled:opacity-50 ${
                leverage === choice
                  ? "bg-sky/12 text-sky ring-1 ring-sky/30 ring-inset"
                  : "text-ink-muted ring-1 ring-hairline ring-inset"
              }`}
            >
              {choice}x
            </button>
          ))}
        </div>
        {leverageLocked && <p className="mt-1 text-[11px] text-ink-faint">포지션·미체결 주문이 없을 때 바꿀 수 있습니다.</p>}
      </div>

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
          <span className="text-xs text-ink-muted">
            가격 ({def.unit}, 호가 단위 {tickText})
          </span>
          <div className="mt-1 flex items-center gap-2">
            <button
              type="button"
              className="btn btn-ghost min-h-10 min-w-10"
              aria-label="호가 한 단계 내리기"
              onClick={() => stepPrice(-1)}
            >
              −
            </button>
            <input
              inputMode="decimal"
              value={priceText}
              onChange={(e) => setPriceText(e.target.value)}
              className={`num w-full rounded-lg border bg-surface-2/60 px-3 py-2 text-right ${
                invalidPrice ? "border-down/60" : "border-hairline"
              }`}
            />
            <button
              type="button"
              className="btn btn-ghost min-h-10 min-w-10"
              aria-label="호가 한 단계 올리기"
              onClick={() => stepPrice(1)}
            >
              +
            </button>
          </div>
        </label>
      )}

      <label className="block">
        <span className="text-xs text-ink-muted">수량 (계약)</span>
        <div className="mt-1 flex items-center gap-2">
          <button type="button" className="btn btn-ghost min-h-10 min-w-10" onClick={() => {
              setActivePct(null);
              setQty((q) => Math.max(1, q - 1));
            }}>
            −
          </button>
          <input
            inputMode="numeric"
            value={qty}
            onChange={(e) => {
              setActivePct(null);
              setQty(Math.max(1, Math.min(MAX_FUTURES_ORDER_QTY, Number(e.target.value.replace(/\D/g, "")) || 1)));
            }}
            className="num w-full rounded-lg border border-hairline bg-surface-2/60 px-3 py-2 text-center"
          />
          <button
            type="button"
            className="btn btn-ghost min-h-10 min-w-10"
            onClick={() => {
              setActivePct(null);
              setQty((q) => Math.min(MAX_FUTURES_ORDER_QTY, q + 1));
            }}
          >
            +
          </button>
        </div>
      </label>

      <div>
        <div className="mb-1.5 flex items-center justify-between text-[11px] text-ink-faint">
          <span>{closing ? "보유 포지션 기준 (청산)" : "주문 가능 금액 기준"}</span>
          <span className="num">최대 {sizingBase.toLocaleString("ko-KR")}계약</span>
        </div>
        <div className="grid grid-cols-4 gap-1.5">
          {([0.1, 0.25, 0.5, 1] as const).map((pct) => (
            <button
              key={pct}
              type="button"
              disabled={sizingBase < 1}
              onClick={() => applyPct(pct)}
              aria-pressed={activePct === pct}
              className={`num rounded-lg border py-1.5 text-xs font-medium transition-colors disabled:opacity-40 ${
                activePct === pct
                  ? side === "BUY"
                    ? "border-up/45 bg-up/15 text-up"
                    : "border-down/45 bg-down/15 text-down"
                  : "border-hairline-soft bg-surface-2/50 text-ink-muted hover:border-hairline hover:text-ink"
              }`}
            >
              {pct * 100}%
            </button>
          ))}
        </div>
      </div>

      <dl className="num space-y-1 text-[13px]">
        <div className="flex justify-between">
          <dt className="text-ink-muted">
            {closingOnly ? "필요 증거금 (청산 주문)" : `필요 증거금 (${leverageLabel(symbol, leverage)})`}
          </dt>
          <dd className="font-semibold">{closingOnly ? "없음" : margin == null ? "—" : krw(margin)}</dd>
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
