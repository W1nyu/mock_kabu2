"use client";

import {
  futureDef,
  futureMarginPerContract,
  orderHoldWithFee,
  FUTURES_EMERGENCY_LOSS_BPS,
  MARKET_BUY_HOLD_FACTOR,
  MAX_FUTURES_ORDER_QTY,
} from "@mock-kabu/shared";
import Link from "next/link";
import TradingFeeNotice from "./TradingFeeNotice";
import { useCallback, useEffect, useState } from "react";
import { api, getUser, newIdempotencyKey } from "@/lib/api";
import { everyVisible } from "@/lib/visible-interval";
import { fmtFuture, krw, LEVERAGE_CHOICES, leverageLabel, toFutureUnits, unitsToInput, type FuturesAccount } from "@/lib/futures";
import { rich, useT } from "@/lib/i18n";

interface AccountInfo {
  tradingFeeExempt?: boolean;
  available: number;
}

/**
 * 선물 주문 — 레버리지, [진입|청산] 탭, 롱/숏, 지정가/시장가, 계약 수.
 * 진입은 레버리지 증거금을 묶고, 청산은 증거금 없이 보유(청산 가능) 수량까지.
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
  const tr = useT();
  const def = futureDef(symbol)!;
  type Mode = "OPEN" | "CLOSE";
  type Dir = "LONG" | "SHORT";
  const [mode, setMode] = useState<Mode>("OPEN");
  // 청산 탭의 % 버튼·예상 실현손익 기준 방향. 처음엔 시트를 연 버튼(매수 → 롱, 매도 → 숏).
  const [dir, setDir] = useState<Dir>(initialSide === "BUY" ? "LONG" : "SHORT");
  const [type, setType] = useState<"LIMIT" | "MARKET">("LIMIT");
  const [priceText, setPriceText] = useState("");
  const [qty, setQty] = useState(1);
  const [available, setAvailable] = useState<number | null>(null);
  const [feeExempt, setFeeExempt] = useState(false);
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
      .then((a) => { setAvailable(a.available); setFeeExempt(a.tradingFeeExempt ?? false); })
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
  const rowOf = (d: Dir) => futures?.positions.find((p) => p.symbol === symbol && p.positionSide === d) ?? null;
  const longRow = rowOf("LONG");
  const shortRow = rowOf("SHORT");
  const held = { LONG: longRow?.qty ?? 0, SHORT: Math.abs(shortRow?.qty ?? 0) };
  const closable = { LONG: longRow?.closableQty ?? 0, SHORT: shortRow?.closableQty ?? 0 };
  // 포지션·미체결이 있으면 레버리지를 못 바꾼다(서버도 막는다).
  const leverageLocked = held.LONG > 0 || held.SHORT > 0 || liveOrders > 0;
  // 청산 탭을 열었는데 고른 방향에 포지션이 없고 반대쪽에 있으면 그쪽으로
  useEffect(() => {
    if (mode === "CLOSE" && held[dir] === 0) {
      const other: Dir = dir === "LONG" ? "SHORT" : "LONG";
      if (held[other] > 0) setDir(other);
    }
  }, [mode, dir, held.LONG, held.SHORT]); // eslint-disable-line react-hooks/exhaustive-deps

  async function chooseLeverage(next: number | null) {
    setLeverageBusy(true);
    setMessage(null);
    try {
      await api("/account/futures/leverage", { method: "POST", body: { symbol, leverage: next } });
      refreshAccount();
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : tr("레버리지를 바꾸지 못했습니다") });
    } finally {
      setLeverageBusy(false);
    }
  }

  const priceUnits = type === "LIMIT" ? toFutureUnits(symbol, priceText) : lastPrice;
  // 서버가 증거금을 잡는 가격: 지정가는 그 가격, 시장가는 최근가 × 1.1(체결 상한)
  const holdPriceUnits = type === "LIMIT" ? priceUnits : lastPrice != null ? Math.ceil(lastPrice * MARKET_BUY_HOLD_FACTOR) : null;
  const marginPerContract = holdPriceUnits != null ? futureMarginPerContract(def, holdPriceUnits, leverage) : null;
  const perContract = holdPriceUnits != null && marginPerContract != null ? Number(feeExempt ? marginPerContract : orderHoldWithFee(marginPerContract, symbol, holdPriceUnits)) : null;
  // 수량 % 버튼의 기준: 청산 탭이면 고른 방향의 청산 가능 수량, 진입 탭이면 주문 가능 금액으로 열 수 있는 최대 계약
  const sizingBase =
    mode === "CLOSE"
      ? Math.min(closable[dir], MAX_FUTURES_ORDER_QTY)
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
  const closeRow = dir === "LONG" ? longRow : shortRow;
  const closeQty = Math.min(qty, closable[dir]);
  // 청산 탭: 이 가격에 닫을 때의 실현손익(평균가 기준)
  const expectedRealized =
    mode === "CLOSE" && closeRow && closeQty > 0 && priceUnits != null
      ? (dir === "LONG" ? 1 : -1) * (priceUnits - closeRow.avgPrice) * closeQty * def.unitValue
      : null;
  // 진입 탭: 긴급 반대매매(평가손실 = 증거금 90%) 예상 가격 — 롱은 아래, 숏은 위
  const emergencyMove =
    mode === "OPEN" && priceUnits != null
      ? (priceUnits * (leverage != null ? Math.ceil(10_000 / leverage) : def.initialMarginBps) * FUTURES_EMERGENCY_LOSS_BPS) / 10_000 / 10_000
      : null;
  const tickText = unitsToInput(symbol, def.tickUnits);
  /** 지정가를 호가 단위만큼 올리고 내린다(입력이 비었거나 틀렸으면 현재가에서 시작, 틱에 맞춘다). */
  function stepPrice(direction: 1 | -1) {
    const base = toFutureUnits(symbol, priceText) ?? lastPrice;
    if (base == null) return;
    const snapped = Math.round(base / def.tickUnits) * def.tickUnits;
    setPriceText(unitsToInput(symbol, Math.max(def.tickUnits, snapped + direction * def.tickUnits)));
  }
  const invalidPrice = type === "LIMIT" && priceUnits == null;

  async function submit(target: Dir) {
    if (invalidPrice) return;
    const orderSide = mode === "OPEN" ? (target === "LONG" ? "BUY" : "SELL") : target === "LONG" ? "SELL" : "BUY";
    const label = tr(mode === "OPEN" ? (target === "LONG" ? "롱 진입" : "숏 진입") : target === "LONG" ? "롱 청산" : "숏 청산");
    setBusy(true);
    setMessage(null);
    try {
      await api("/orders", {
        method: "POST",
        headers: { "idempotency-key": newIdempotencyKey() },
        body: { symbol, side: orderSide, positionSide: target, type, qty, ...(type === "LIMIT" ? { price: priceUnits } : {}) },
      });
      setMessage({ ok: true, text: tr("{label} {n}계약 주문을 접수했습니다", { label, n: qty }) });
      refreshAccount();
      onPlaced();
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : tr("주문에 실패했습니다") });
    } finally {
      setBusy(false);
    }
  }

  if (loggedIn === null) return <div className="glass min-h-[320px]" aria-busy />;
  if (!loggedIn) {
    return (
      <div className="glass p-4 text-sm text-ink-muted">
        {rich(tr("선물 주문은 {login} 후 이용할 수 있습니다."), {
          login: (
            <Link href="/login" className="text-sky">
              {tr("로그인")}
            </Link>
          ),
        })}
      </div>
    );
  }

  return (
    <div className="glass space-y-3 p-4">
      <TradingFeeNotice symbol={symbol} price={priceUnits} qty={qty} leverage={leverage} exempt={feeExempt} />
      <div>
        <div className="flex items-center justify-between text-xs text-ink-muted">
          <span>{tr("레버리지")}</span>
          <span className="num font-semibold text-ink">{leverageLabel(symbol, leverage)}</span>
        </div>
        <div className="mt-1.5 flex flex-wrap gap-1" role="group" aria-label={tr("레버리지")}>
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
            {tr("기본")}
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
        {leverageLocked && <p className="mt-1 text-[11px] text-ink-faint">{tr("포지션·미체결 주문이 없을 때 바꿀 수 있습니다.")}</p>}
      </div>

      <div className="grid grid-cols-2 gap-1 rounded-xl bg-surface-2/60 p-1" role="tablist">
        {(["OPEN", "CLOSE"] as const).map((m) => (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={mode === m}
            onClick={() => { setMode(m); setActivePct(null); }}
            className={`min-h-10 rounded-lg text-sm font-semibold transition-colors ${mode === m ? "bg-surface-3 text-ink" : "text-ink-muted"}`}
          >
            {m === "OPEN" ? tr("진입") : tr("청산")}
          </button>
        ))}
      </div>
      {mode === "CLOSE" && (
        <div className="grid grid-cols-2 gap-1.5" role="group" aria-label={tr("청산할 포지션")}>
          {(["LONG", "SHORT"] as const).map((d) => (
            <button
              key={d}
              type="button"
              disabled={held[d] === 0}
              onClick={() => { setDir(d); setActivePct(null); }}
              aria-pressed={dir === d}
              className={`num rounded-lg border px-2 py-1.5 text-left text-[12px] disabled:opacity-40 ${
                dir === d ? (d === "LONG" ? "border-up/45 bg-up/10" : "border-down/45 bg-down/10") : "border-hairline-soft"
              }`}
            >
              <span className={`font-semibold ${d === "LONG" ? "text-up" : "text-down"}`}>{d === "LONG" ? tr("롱") : tr("숏")}</span>{" "}
              {tr("{n}계약", { n: held[d] })}
              <span className="block text-[11px] text-ink-faint">{tr("청산 가능 {n}계약", { n: closable[d] })}</span>
            </button>
          ))}
        </div>
      )}

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
            {t === "LIMIT" ? tr("지정가") : tr("시장가")}
          </button>
        ))}
      </div>

      {type === "LIMIT" && (
        <label className="block">
          <span className="text-xs text-ink-muted">
            {tr("가격 ({unit}, 호가 단위 {tick})", { unit: tr(def.unit), tick: tickText })}
          </span>
          <div className="mt-1 flex items-center gap-2">
            <button
              type="button"
              className="btn btn-ghost min-h-10 min-w-10"
              aria-label={tr("호가 한 단계 내리기")}
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
              aria-label={tr("호가 한 단계 올리기")}
              onClick={() => stepPrice(1)}
            >
              +
            </button>
          </div>
        </label>
      )}

      <label className="block">
        <span className="text-xs text-ink-muted">{tr("수량 (계약)")}</span>
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
          <span>{mode === "CLOSE" ? tr("청산 가능 수량 기준") : tr("주문 가능 금액 기준")}</span>
          <span className="num">{tr("최대 {n}계약", { n: sizingBase.toLocaleString("ko-KR") })}</span>
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
                  ? mode === "CLOSE"
                    ? dir === "LONG"
                      ? "border-up/45 bg-up/15 text-up"
                      : "border-down/45 bg-down/15 text-down"
                    : "border-sky/45 bg-sky/12 text-sky"
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
          <dt className="text-ink-muted">{mode === "CLOSE" ? tr("필요 증거금 (청산 주문)") : tr("주문 예약금 (수수료 포함)")}</dt>
          <dd className="font-semibold">{mode === "CLOSE" ? tr("없음") : margin == null ? "—" : krw(margin)}</dd>
        </div>
        {expectedRealized != null && (
          <div className="flex justify-between">
            <dt className="text-ink-muted">
              {type === "MARKET"
                ? tr("예상 실현손익 ({n}계약 청산, 현재가 기준)", { n: closeQty })
                : tr("예상 실현손익 ({n}계약 청산)", { n: closeQty })}
            </dt>
            <dd className={`font-semibold ${expectedRealized > 0 ? "text-up" : expectedRealized < 0 ? "text-down" : ""}`}>
              {expectedRealized > 0 ? "+" : ""}
              {krw(expectedRealized)}
            </dd>
          </div>
        )}
        {emergencyMove != null && priceUnits != null && (
          <div className="flex justify-between" title={tr("평가손실이 이 포지션 증거금의 90%가 되는 가격 — 여기에 닿으면 즉시 전량 반대매매")}>
            <dt className="text-ink-muted">{tr("긴급 반대매매가 (예상)")}</dt>
            <dd className="text-ink-muted">
              <span className="text-up">{tr("롱")}</span> {fmtFuture(symbol, Math.round(priceUnits - emergencyMove))} ·{" "}
              <span className="text-down">{tr("숏")}</span> {fmtFuture(symbol, Math.round(priceUnits + emergencyMove))}
            </dd>
          </div>
        )}
        <div className="flex justify-between">
          <dt className="text-ink-muted">{tr("주문 가능 금액")}</dt>
          <dd>{available == null ? "—" : krw(available)}</dd>
        </div>
        {type === "MARKET" && (
          <div className="flex justify-between text-ink-faint">
            <dt>{tr("현재가")}</dt>
            <dd>{fmtFuture(symbol, lastPrice)}</dd>
          </div>
        )}
      </dl>

      <div className="grid grid-cols-2 gap-2">
        {(["LONG", "SHORT"] as const).map((d) => (
          <button
            key={d}
            type="button"
            disabled={busy || invalidPrice || (mode === "CLOSE" && closable[d] === 0)}
            onClick={() => void submit(d)}
            className={`min-h-11 rounded-xl text-sm font-semibold text-white disabled:opacity-50 ${d === "LONG" ? "bg-up" : "bg-down"}`}
          >
            {busy
              ? tr("주문 중…")
              : tr(mode === "OPEN" ? (d === "LONG" ? "롱 진입" : "숏 진입") : d === "LONG" ? "롱 청산" : "숏 청산")}
          </button>
        ))}
      </div>
      {message && <p className={`text-[13px] ${message.ok ? "text-ok" : "text-down"}`}>{message.text}</p>}
      <p className="text-[11px] leading-5 text-ink-faint">
        {tr("1일물 — 매일 04:10 점검 시간에 그 시각 기초자산 가격으로 현금 정산되고 포지션이 사라집니다.")}
      </p>
    </div>
  );
}
