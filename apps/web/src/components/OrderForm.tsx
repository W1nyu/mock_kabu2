"use client";

import {
  MARKET_BUY_HOLD_FACTOR,
  TRAIL_BPS_MAX,
  TRAIL_BPS_MIN,
  describeCondition,
  inferTriggerDirection,
  isOnTick,
  tickSizeOf,
  trailingTrigger,
  type TriggerDirection,
} from "@mock-kabu/shared";
import { useEffect, useState } from "react";
import { api, fmt, getUser, newIdempotencyKey, won } from "@/lib/api";
import { subscribe } from "@/lib/socket";
import { ACCOUNT_REFRESH_DEBOUNCE_MS, debounce } from "@/lib/debounce";
import { everyVisible } from "@/lib/visible-interval";
import { useT } from "@/lib/i18n";

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
  initialSide = "BUY",
}: {
  symbol: string;
  /** 호가창 클릭. seq가 바뀔 때마다 가격을 넣고 방향도 맞춘다 (같은 값을 다시 눌러도 반영). */
  priceHint: { price: number; seq: number } | null;
  lastPrice: number | null;
  onPlaced?: () => void;
  /** 폰 거래 화면의 매수/매도 버튼으로 열 때 처음 선택될 방향. */
  initialSide?: "BUY" | "SELL";
}) {
  const tr = useT();
  const [side, setSide] = useState<"BUY" | "SELL">(initialSide);
  const [type, setType] = useState<"LIMIT" | "MARKET" | "STOP">("LIMIT");
  const [price, setPrice] = useState("");
  const [triggerPrice, setTriggerPrice] = useState("");
  // 조건부 모드의 하위 방식: 고정 가격 트리거 또는 고점/저점 추적(트레일링)
  const [stopMode, setStopMode] = useState<"FIXED" | "TRAIL">("FIXED");
  // 발동 시 접수할 주문 유형. 지정가면 발동가 근처에 걸어 슬리피지를 제한하되 미체결 위험을 진다.
  const [stopExec, setStopExec] = useState<"MARKET" | "LIMIT">("MARKET");
  const [stopLimitPrice, setStopLimitPrice] = useState("");
  // 매수 체결 후 손절/익절을 자동 등록하는 브래킷. % 단위로 받고 서버에는 bps로 보낸다.
  const [bracketOn, setBracketOn] = useState(false);
  const [bracketStopPct, setBracketStopPct] = useState("5");
  const [bracketTakePct, setBracketTakePct] = useState("10");
  const [trailPct, setTrailPct] = useState("3");
  // null이면 현재가 대비 트리거 위치로 자동 추론, 사용자가 고르면 고정
  const [directionOverride, setDirectionOverride] = useState<TriggerDirection | null>(null);
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
      // 호가 클릭은 현재 모드의 가격 칸으로 들어가고, 시장가였으면 지정가로 바꾼다.
      // 매수/매도 방향은 그대로 둔다(아래 호가를 눌러 낮게 사고 싶은 경우가 흔하다).
      if (type === "STOP") setTriggerPrice(String(priceHint.price));
      else {
        setPrice(String(priceHint.price));
        if (type === "MARKET") setType("LIMIT");
      }
      setActivePct(null);
      setSizingNote(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [priceHint?.seq]);

  function refreshLimits() {
    api<AccountInfo>("/account")
      .then(setAccount)
      .catch(() => {});
    api<HoldingRow[]>("/account/holdings")
      .then((rows) => setHolding(rows.find((h) => h.symbol === symbol) ?? null))
      .catch(() => {});
  }

  useEffect(() => {
    // 종목 전환 직후 이전 종목의 매도 가능 수량이 잠시 보이지 않게 한다.
    setHolding(null);
    refreshLimits();
    // account:{id} push가 주 갱신 경로, 폴링은 push 유실 대비 fallback
    const t = everyVisible(refreshLimits, 15000);
    const user = getUser();
    const refreshSoon = debounce(refreshLimits, ACCOUNT_REFRESH_DEBOUNCE_MS);
    const unsub = user ? subscribe([`account:${user.accountId}`], () => refreshSoon()) : () => {};
    return () => {
      t();
      refreshSoon.cancel();
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
      if (type === "STOP" && stopMode === "TRAIL") {
        await api("/orders/conditional", {
          method: "POST",
          body: { symbol, side, qty: Number(qty), orderType: "MARKET", trailBps: trailBps },
        });
        setMessage({
          ok: true,
          text:
            side === "SELL"
              ? tr("트레일링 예약 등록: 고점 대비 {pct}% 하락 시 {qty}주 시장가 매도", { pct: trailPct, qty: fmt.format(Number(qty)) })
              : tr("트레일링 예약 등록: 저점 대비 {pct}% 반등 시 {qty}주 시장가 매수", { pct: trailPct, qty: fmt.format(Number(qty)) }),
        });
      } else if (type === "STOP") {
        await api("/orders/conditional", {
          method: "POST",
          body: {
            symbol,
            side,
            direction: triggerDirection,
            triggerPrice: Number(triggerPrice),
            qty: Number(qty),
            orderType: stopExec,
            ...(stopExec === "LIMIT" ? { limitPrice: Number(stopLimitPrice) } : {}),
          },
        });
        setMessage({
          ok: true,
          text: tr(
            triggerDirection === "AT_OR_ABOVE"
              ? "예약 주문 등록: {trigger} 이상이면 {qty}주 {exec} {side}"
              : "예약 주문 등록: {trigger} 이하이면 {qty}주 {exec} {side}",
            {
              trigger: won(Number(triggerPrice)),
              qty: fmt.format(Number(qty)),
              exec: stopExec === "LIMIT" ? tr("{price} 지정가", { price: won(Number(stopLimitPrice)) }) : tr("시장가"),
              side: side === "BUY" ? tr("매수") : tr("매도"),
            },
          ),
        });
      } else {
        await api("/orders", {
          method: "POST",
          headers: { "idempotency-key": newIdempotencyKey() },
          body: {
            symbol,
            side,
            type,
            qty: Number(qty),
            ...(type === "LIMIT" ? { price: Number(price) } : {}),
            ...(bracketActive ? { bracket: { stopBps: bracketStopBps, takeBps: bracketTakeBps } } : {}),
          },
        });
        setMessage({
          ok: true,
          text: bracketActive
            ? tr("주문 접수 · 체결되면 {legs}를 자동 등록합니다", {
                legs: [
                  bracketStopBps != null ? tr("손절 −{pct}%", { pct: bracketStopPct }) : null,
                  bracketTakeBps != null ? tr("익절 +{pct}%", { pct: bracketTakePct }) : null,
                ]
                  .filter(Boolean)
                  .join(" / "),
              })
            : tr("주문이 접수되었습니다"),
        });
      }
      setQty("");
      resetSizing();
      refreshLimits();
      onPlaced?.();
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : tr("주문 실패") });
    } finally {
      setBusy(false);
    }
  }

  const parsedQty = Number(qty);
  const validQty = Number.isSafeInteger(parsedQty) && parsedQty > 0;
  const parsedLimitPrice = Number(price);
  const limitPrice =
    Number.isSafeInteger(parsedLimitPrice) && parsedLimitPrice > 0 ? parsedLimitPrice : null;
  const tickSize = tickSizeOf(symbol);
  // 서버가 격자 밖 지정가를 거부하므로 미리 알리고 버튼을 잠근다.
  const offTick = limitPrice != null && tickSize != null && !isOnTick(limitPrice, tickSize);
  const nearestTick =
    offTick && tickSize != null
      ? Math.max(tickSize, Math.round(limitPrice! / tickSize) * tickSize)
      : null;

  const parsedTrigger = Number(triggerPrice);
  const validTrigger = Number.isSafeInteger(parsedTrigger) && parsedTrigger > 0;
  const triggerDirection: TriggerDirection =
    directionOverride ??
    (validTrigger && lastPrice != null
      ? inferTriggerDirection(parsedTrigger, lastPrice, side)
      : side === "SELL"
        ? "AT_OR_BELOW"
        : "AT_OR_ABOVE");
  // 브래킷: 매수 + 일반 주문에서만. 0.1%~50% / 0.1%~100%. 빈 칸은 그쪽을 걸지 않는다(하나는 필요).
  const bracketStopBps = bracketStopPct.trim() === "" ? null : Math.round((Number(bracketStopPct) || 0) * 100);
  const bracketTakeBps = bracketTakePct.trim() === "" ? null : Math.round((Number(bracketTakePct) || 0) * 100);
  const bracketValid =
    (bracketStopBps != null || bracketTakeBps != null) &&
    (bracketStopBps == null || (bracketStopBps >= TRAIL_BPS_MIN && bracketStopBps <= TRAIL_BPS_MAX)) &&
    (bracketTakeBps == null || (bracketTakeBps >= TRAIL_BPS_MIN && bracketTakeBps <= 10_000));
  const bracketActive = side === "BUY" && type !== "STOP" && bracketOn;
  // 조건부 지정가 발동: 발동 후 걸 지정가도 호가 단위에 맞아야 한다.
  const parsedStopLimit = Number(stopLimitPrice);
  const stopLimitValid =
    stopExec !== "LIMIT" ||
    (Number.isSafeInteger(parsedStopLimit) &&
      parsedStopLimit > 0 &&
      (tickSize == null || isOnTick(parsedStopLimit, tickSize)));
  // 트레일링: 0.1%~50%, 서버와 같은 bps 단위로 반올림한다.
  const trailBps = Math.round((Number(trailPct) || 0) * 100);
  const validTrail = trailBps >= TRAIL_BPS_MIN && trailBps <= TRAIL_BPS_MAX;
  const trailPreview =
    validTrail && lastPrice != null && lastPrice > 0
      ? trailingTrigger(side, lastPrice, trailBps)
      : null;
  // 현재가가 이미 조건을 만족하면 서버가 거부하므로 미리 알려준다.
  const triggerAlreadyMet =
    type === "STOP" && validTrigger && lastPrice != null
      ? triggerDirection === "AT_OR_ABOVE"
        ? lastPrice >= parsedTrigger
        : lastPrice <= parsedTrigger
      : false;

  // % 버튼의 매수 기준가 — 시장가는 ceil(최근가*110%)*수량이 홀드되므로(order.service) 같은 기준이어야 거부되지 않음
  // 조건부는 발동 시 시장가로 접수되므로 시장가와 같은 기준을 쓴다.
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
          ? tr("주문 가능 현금으로는 현재 기준가의 1주를 매수할 수 없습니다.")
          : tr("매도 가능한 보유 수량이 없습니다."),
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
    <form onSubmit={submit} className="glass overflow-hidden">
      <div className="panel-head">
        <span className="panel-title">{tr("주문")}</span>
        <span className="num text-[11px] text-ink-faint">{symbol}</span>
      </div>

      <div className="space-y-4 p-4">
        {/* Side — a segmented control inside a well, so the active half reads as lit. */}
        <div className="well grid grid-cols-2 gap-1 p-1">
          {(["BUY", "SELL"] as const).map((s) => {
            const active = side === s;
            return (
              <button
                key={s}
                type="button"
                onClick={() => {
                  setSide(s);
                  resetSizing();
                }}
                aria-pressed={active}
                className={`rounded-lg py-2 text-sm font-semibold transition-colors ${
                  active
                    ? s === "BUY"
                      ? "bg-up/18 text-up ring-1 ring-inset ring-up/45"
                      : "bg-down/18 text-down ring-1 ring-inset ring-down/45"
                    : "text-ink-muted hover:bg-surface-3/45 hover:text-ink"
                }`}
              >
                {s === "BUY" ? tr("매수") : tr("매도")}
              </button>
            );
          })}
        </div>

        {/* Order type */}
        <div className="well grid grid-cols-3 gap-1 p-1">
          {(["LIMIT", "MARKET", "STOP"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => {
                setType(t);
                resetSizing();
              }}
              aria-pressed={type === t}
              className={`rounded-lg py-1.5 text-xs font-medium transition-colors ${
                type === t
                  ? "bg-surface-3/60 text-ink"
                  : "text-ink-muted hover:bg-surface-3/45 hover:text-ink"
              }`}
            >
              {t === "LIMIT" ? tr("지정가") : t === "MARKET" ? tr("시장가") : tr("조건부")}
            </button>
          ))}
        </div>

        {type === "STOP" && (
          <div className="space-y-3">
            <div className="well grid grid-cols-2 gap-1 p-1" role="group" aria-label={tr("조건 방식")}>
              {(["FIXED", "TRAIL"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setStopMode(m)}
                  aria-pressed={stopMode === m}
                  title={
                    m === "FIXED"
                      ? tr("정해둔 가격에 닿으면 발동")
                      : side === "SELL"
                        ? tr("등록 후 고점에서 정한 비율만큼 내려오면 발동 — 오를수록 손절선도 따라 올라갑니다")
                        : tr("등록 후 저점에서 정한 비율만큼 반등하면 발동")
                  }
                  className={`rounded-lg py-1.5 text-xs font-medium transition-colors ${
                    stopMode === m
                      ? "bg-surface-3/60 text-ink"
                      : "text-ink-muted hover:bg-surface-3/45 hover:text-ink"
                  }`}
                >
                  {m === "FIXED" ? tr("고정 가격") : tr("트레일링")}
                </button>
              ))}
            </div>
            {stopMode === "TRAIL" ? (
              <div>
                <label className="label" htmlFor={`order-trail-${symbol}`}>
                  {side === "SELL" ? tr("고점 대비 하락률 (%)") : tr("저점 대비 반등률 (%)")}
                </label>
                <input
                  id={`order-trail-${symbol}`}
                  className="field num"
                  inputMode="decimal"
                  value={trailPct}
                  onChange={(e) => setTrailPct(e.target.value.replace(/[^0-9.]/g, ""))}
                  placeholder="3"
                />
                <p className="mt-1.5 text-[11px] text-ink-faint">
                  {validTrail
                    ? trailPreview != null
                      ? side === "SELL"
                        ? tr("지금 등록하면 트리거 {price}부터 시작 · 새 고점마다 자동으로 따라갑니다", { price: won(trailPreview) })
                        : tr("지금 등록하면 트리거 {price}부터 시작 · 새 저점마다 자동으로 따라갑니다", { price: won(trailPreview) })
                      : tr("현재가를 기준으로 트리거가 정해집니다")
                    : tr("{min}%~{max}% 사이로 입력하세요", { min: TRAIL_BPS_MIN / 100, max: TRAIL_BPS_MAX / 100 })}
                </p>
              </div>
            ) : (
              <div>
                <label className="label" htmlFor={`order-trigger-${symbol}`}>
                  {tr("트리거 가격")}
                </label>
                <input
                  id={`order-trigger-${symbol}`}
                  className="field num"
                  inputMode="numeric"
                  value={triggerPrice}
                  onChange={(e) => {
                    setTriggerPrice(e.target.value.replace(/[^0-9]/g, ""));
                    setDirectionOverride(null);
                  }}
                  placeholder={tr("호가를 클릭해도 입력됩니다")}
                />
              </div>
            )}
            {stopMode === "FIXED" && (
              <div className="well grid grid-cols-2 gap-1 p-1" role="group" aria-label={tr("발동 조건")}>
                {(["AT_OR_BELOW", "AT_OR_ABOVE"] as const).map((d) => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => setDirectionOverride(d)}
                    aria-pressed={triggerDirection === d}
                    className={`rounded-lg py-1.5 text-xs font-medium transition-colors ${
                      triggerDirection === d
                        ? "bg-surface-3/60 text-ink"
                        : "text-ink-muted hover:bg-surface-3/45 hover:text-ink"
                    }`}
                  >
                    {d === "AT_OR_BELOW" ? tr("이하가 되면") : tr("이상이 되면")}
                  </button>
                ))}
              </div>
            )}
            {stopMode === "FIXED" && (
              <div className="space-y-2">
                <div
                  className="well grid grid-cols-2 gap-1 p-1"
                  role="group"
                  aria-label={tr("발동 시 주문 유형")}
                >
                  {(["MARKET", "LIMIT"] as const).map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setStopExec(m)}
                      aria-pressed={stopExec === m}
                      title={
                        m === "MARKET"
                          ? tr("발동 즉시 시장가로 체결 — 확실히 나가지만 급락장에선 미끄러질 수 있습니다")
                          : tr("발동 후 지정가를 겁니다 — 슬리피지를 막지만 가격이 지나가면 미체결로 남습니다")
                      }
                      className={`rounded-lg py-1.5 text-xs font-medium transition-colors ${
                        stopExec === m
                          ? "bg-surface-3/60 text-ink"
                          : "text-ink-muted hover:bg-surface-3/45 hover:text-ink"
                      }`}
                    >
                      {m === "MARKET" ? tr("발동 시 시장가") : tr("발동 시 지정가")}
                    </button>
                  ))}
                </div>
                {stopExec === "LIMIT" && (
                  <div>
                    <label className="label" htmlFor={`order-stop-limit-${symbol}`}>
                      {tr("발동 후 지정가")}
                      {tickSize != null && (
                        <span className="ml-1.5 font-normal text-ink-faint">
                          {tr("호가 단위 {tick}", { tick: won(tickSize) })}
                        </span>
                      )}
                    </label>
                    <input
                      id={`order-stop-limit-${symbol}`}
                      className="field num"
                      inputMode="numeric"
                      value={stopLimitPrice}
                      onChange={(e) => setStopLimitPrice(e.target.value.replace(/[^0-9]/g, ""))}
                      placeholder={validTrigger ? String(parsedTrigger) : tr("예: 트리거 가격")}
                    />
                  </div>
                )}
              </div>
            )}
            <p className="text-[11px] text-ink-faint">
              {stopMode === "TRAIL"
                ? side === "SELL"
                  ? tr("트레일링 손절")
                  : tr("트레일링 매수")
                : tr(describeCondition(triggerDirection, side))}{" "}
              ·{" "}
              {tr("조건 충족 시 {exec}로 접수됩니다. 대기 중에는 현금·수량을 홀드하지 않습니다.", {
                exec: stopMode === "FIXED" && stopExec === "LIMIT" ? tr("지정가") : tr("시장가"),
              })}
            </p>
          </div>
        )}

        {type === "LIMIT" && (
          <div>
            <label className="label" htmlFor={`order-price-${symbol}`}>
              {tr("가격")}
              {tickSize != null && (
                <span className="ml-1.5 font-normal text-ink-faint">
                  {tr("호가 단위 {tick}", { tick: won(tickSize) })}
                </span>
              )}
            </label>
            <input
              id={`order-price-${symbol}`}
              className="field num"
              inputMode="numeric"
              value={price}
              onChange={(e) => {
                setPrice(e.target.value.replace(/[^0-9]/g, ""));
                resetSizing();
              }}
              placeholder={tr("호가를 클릭해도 입력됩니다")}
            />
          </div>
        )}

        <div>
          <label className="label" htmlFor={`order-qty-${symbol}`}>
            {tr("수량")}
          </label>
          <input
            id={`order-qty-${symbol}`}
            className="field num"
            inputMode="numeric"
            value={qty}
            onChange={(e) => {
              setQty(e.target.value.replace(/[^0-9]/g, ""));
              resetSizing();
            }}
            placeholder="0"
          />
        </div>

        {/* Quick sizing */}
        <div>
          <div className="mb-1.5 flex items-center justify-between text-[11px] text-ink-faint">
            <span>{side === "BUY" ? tr("주문 가능 현금 기준") : tr("매도 가능 수량 기준")}</span>
            {side === "BUY" && buyRefPrice != null && (
              <span className="num">
                {type === "LIMIT" ? tr("지정가") : tr("최근가 110%")} {won(buyRefPrice)}
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
                      ? tr("주문 가능 현금 대비 (가격 입력 필요)")
                      : tr("주문 가능 현금 대비 (최근가 110% 기준)")
                    : tr("매도 가능 수량 대비")
                }
                className={`num rounded-lg border py-1.5 text-xs font-medium transition-colors disabled:opacity-40 ${
                  activePct === pct
                    ? side === "BUY"
                      ? "border-up/45 bg-up/15 text-up"
                      : "border-down/45 bg-down/15 text-down"
                    : "border-hairline-soft bg-surface-2/50 text-ink-muted hover:border-hairline hover:text-ink"
                }`}
              >
                {pct === 1 ? tr("최대") : `${pct * 100}%`}
              </button>
            ))}
          </div>
        </div>

        {side === "BUY" && type !== "STOP" && (
          <div className="well px-3 py-2.5 text-xs">
            <label className="flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                checked={bracketOn}
                onChange={(e) => setBracketOn(e.target.checked)}
                className="accent-sky"
              />
              <span className="font-medium">{tr("체결 후 손절/익절 자동 등록")}</span>
              <span className="text-ink-faint">{tr("(하나만 입력해도 됨)")}</span>
            </label>
            {bracketOn && (
              <div className="num mt-2 grid grid-cols-2 gap-2">
                <label className="flex items-center gap-1.5">
                  <span className="text-down">{tr("손절")} −</span>
                  <input
                    className="field w-16 py-1 text-xs"
                    inputMode="decimal"
                    value={bracketStopPct}
                    placeholder={tr("없음")}
                    onChange={(e) => setBracketStopPct(e.target.value.replace(/[^0-9.]/g, ""))}
                  />
                  <span className="text-ink-faint">%</span>
                </label>
                <label className="flex items-center gap-1.5">
                  <span className="text-up">{tr("익절")} +</span>
                  <input
                    className="field w-16 py-1 text-xs"
                    inputMode="decimal"
                    value={bracketTakePct}
                    placeholder={tr("없음")}
                    onChange={(e) => setBracketTakePct(e.target.value.replace(/[^0-9.]/g, ""))}
                  />
                  <span className="text-ink-faint">%</span>
                </label>
                <p className="col-span-2 text-[11px] text-ink-faint">
                  {tr("체결 평균가 기준으로 계산합니다. 한쪽을 비우면 그쪽은 걸지 않습니다. 부분 체결이면 체결된 수량만 보호하고, 등록 전에 이미 선을 넘었으면 즉시 시장가로 정리합니다.")}
                </p>
              </div>
            )}
          </div>
        )}

        {/* Balance readout */}
        <div className="well num space-y-1 px-3 py-2.5 text-xs">
          {side === "BUY" ? (
            <>
              <p className="flex items-baseline justify-between gap-2">
                <span className="text-ink-muted">{tr("주문 가능 현금")}</span>
                <span className="font-semibold">
                  {account ? won(account.available) : tr("불러오는 중")}
                </span>
              </p>
              {account && (
                <p className="flex items-baseline justify-between gap-2 text-ink-faint">
                  <span>{tr("예수금")}</span>
                  <span>
                    {won(account.balance)}
                    {account.holdAmount > 0 && ` · ${tr("대기 {amount} 제외", { amount: won(account.holdAmount) })}`}
                  </span>
                </p>
              )}
              {maxBuyQty != null && (
                <p className="flex items-baseline justify-between gap-2 text-ink-faint">
                  <span>{tr("최대 매수 가능")}</span>
                  <span>{tr("{n}주", { n: fmt.format(maxBuyQty) })}</span>
                </p>
              )}
            </>
          ) : (
            <>
              <p className="flex items-baseline justify-between gap-2">
                <span className="text-ink-muted">{tr("매도 가능 수량")}</span>
                <span className="font-semibold">{tr("{n}주", { n: fmt.format(availableQty) })}</span>
              </p>
              <p className="flex items-baseline justify-between gap-2 text-ink-faint">
                <span>{tr("보유")}</span>
                <span>
                  {tr("{n}주", { n: fmt.format(holding?.qty ?? 0) })}
                  {holding &&
                    holding.holdQty > 0 &&
                    ` · ${tr("대기 {amount} 제외", { amount: tr("{n}주", { n: fmt.format(holding.holdQty) }) })}`}
                </span>
              </p>
            </>
          )}
          {estimate != null && (
            <p className="flex items-baseline justify-between gap-2 border-t border-hairline-soft pt-1.5">
              <span className="text-ink-muted">
                {side === "BUY" && type !== "LIMIT" ? tr("예상 최대 홀드") : tr("예상 주문금액")}
              </span>
              <span className="font-semibold text-sky">{won(estimate)}</span>
            </p>
          )}
        </div>

        {/* Advisories */}
        <div className="space-y-1 text-xs">
          {type === "MARKET" && side === "BUY" && (
            <p className="text-ink-faint">{tr("시장가 매수는 최근가의 110%까지 증거금이 홀드됩니다")}</p>
          )}
          {type === "STOP" && stopMode === "FIXED" && triggerAlreadyMet && (
            <p className="text-warn">
              {tr("현재가가 이미 조건을 만족합니다. 바로 체결하려면 시장가 주문을 이용하세요.")}
            </p>
          )}
          {sizingNote && <p className="text-warn">{sizingNote}</p>}
          {type === "LIMIT" && offTick && nearestTick != null && (
            <p className="text-warn">
              {tr("호가 단위 {tick}에 맞지 않습니다.", { tick: won(tickSize!) })}{" "}
              <button
                type="button"
                className="underline underline-offset-2 hover:text-ink"
                onClick={() => setPrice(String(nearestTick))}
              >
                {tr("{price}으로 맞추기", { price: won(nearestTick) })}
              </button>
            </p>
          )}
          {exceedsAvailableCash && (
            <p className="text-warn">
              {tr("입력 수량이 현재 주문 가능 현금을 초과합니다. 접수 시 다시 확인됩니다.")}
            </p>
          )}
          {exceedsAvailableShares && (
            <p className="text-warn">
              {tr("입력 수량이 현재 매도 가능 수량을 초과합니다. 접수 시 다시 확인됩니다.")}
            </p>
          )}
        </div>

        {message && (
          <p
            className={`rounded-control border px-3 py-2 text-sm ${
              message.ok ? "border-ok/30 bg-ok/8 text-ok" : "border-up/30 bg-up/8 text-up"
            }`}
          >
            {message.text}
          </p>
        )}

        <button
          disabled={
            busy ||
            !validQty ||
            (type === "LIMIT" && (limitPrice == null || offTick)) ||
            (bracketActive && !bracketValid) ||
            (type === "STOP" &&
              stopMode === "FIXED" &&
              (!validTrigger || triggerAlreadyMet || !stopLimitValid)) ||
            (type === "STOP" && stopMode === "TRAIL" && !validTrail)
          }
          className={`btn btn-block ${side === "BUY" ? "btn-buy" : "btn-sell"}`}
        >
          {busy
            ? tr("접수 중…")
            : type === "STOP"
              ? side === "BUY"
                ? tr("매수 예약")
                : tr("매도 예약")
              : side === "BUY"
                ? tr("매수 주문")
                : tr("매도 주문")}
        </button>
      </div>
    </form>
  );
}
