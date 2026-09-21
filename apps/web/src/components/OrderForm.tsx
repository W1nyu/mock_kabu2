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
  const [type, setType] = useState<"LIMIT" | "MARKET" | "STOP">("LIMIT");
  const [price, setPrice] = useState("");
  const [triggerPrice, setTriggerPrice] = useState("");
  // 조건부 모드의 하위 방식: 고정 가격 트리거 또는 고점/저점 추적(트레일링)
  const [stopMode, setStopMode] = useState<"FIXED" | "TRAIL">("FIXED");
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
      // 호가 클릭은 현재 모드의 가격 칸으로 들어간다.
      if (type === "STOP") setTriggerPrice(String(priceHint));
      else setPrice(String(priceHint));
      setActivePct(null);
      setSizingNote(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [priceHint]);

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
      if (type === "STOP" && stopMode === "TRAIL") {
        await api("/orders/conditional", {
          method: "POST",
          body: { symbol, side, qty: Number(qty), orderType: "MARKET", trailBps: trailBps },
        });
        setMessage({
          ok: true,
          text: `트레일링 예약 등록: ${side === "SELL" ? "고점" : "저점"} 대비 ${trailPct}% ${
            side === "SELL" ? "하락" : "반등"
          } 시 ${fmt.format(Number(qty))}주 시장가 ${side === "BUY" ? "매수" : "매도"}`,
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
            orderType: "MARKET",
          },
        });
        setMessage({
          ok: true,
          text: `예약 주문 등록: ${fmt.format(Number(triggerPrice))}원 ${
            triggerDirection === "AT_OR_ABOVE" ? "이상" : "이하"
          }이면 ${fmt.format(Number(qty))}주 시장가 ${side === "BUY" ? "매수" : "매도"}`,
        });
      } else {
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
      }
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
  const tickSize = tickSizeOf(symbol);
  // 서버가 격자 밖 지정가를 거부하므로 미리 알리고 버튼을 잠근다.
  const offTick = limitPrice != null && tickSize != null && !isOnTick(limitPrice, tickSize);
  const nearestTick =
    offTick && tickSize != null ? Math.max(tickSize, Math.round(limitPrice! / tickSize) * tickSize) : null;

  const parsedTrigger = Number(triggerPrice);
  const validTrigger = Number.isSafeInteger(parsedTrigger) && parsedTrigger > 0;
  const triggerDirection: TriggerDirection =
    directionOverride ??
    (validTrigger && lastPrice != null
      ? inferTriggerDirection(parsedTrigger, lastPrice, side)
      : side === "SELL"
        ? "AT_OR_BELOW"
        : "AT_OR_ABOVE");
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
    <form onSubmit={submit} className="glass overflow-hidden">
      <div className="panel-head">
        <span className="panel-title">주문</span>
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
                    : "text-ink-muted hover:bg-white/6 hover:text-ink"
                }`}
              >
                {s === "BUY" ? "매수" : "매도"}
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
                  ? "bg-white/10 text-ink"
                  : "text-ink-muted hover:bg-white/6 hover:text-ink"
              }`}
            >
              {t === "LIMIT" ? "지정가" : t === "MARKET" ? "시장가" : "조건부"}
            </button>
          ))}
        </div>

        {type === "STOP" && (
          <div className="space-y-3">
            <div className="well grid grid-cols-2 gap-1 p-1" role="group" aria-label="조건 방식">
              {(["FIXED", "TRAIL"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setStopMode(m)}
                  aria-pressed={stopMode === m}
                  title={
                    m === "FIXED"
                      ? "정해둔 가격에 닿으면 발동"
                      : side === "SELL"
                        ? "등록 후 고점에서 정한 비율만큼 내려오면 발동 — 오를수록 손절선도 따라 올라갑니다"
                        : "등록 후 저점에서 정한 비율만큼 반등하면 발동"
                  }
                  className={`rounded-lg py-1.5 text-xs font-medium transition-colors ${
                    stopMode === m
                      ? "bg-white/10 text-ink"
                      : "text-ink-muted hover:bg-white/6 hover:text-ink"
                  }`}
                >
                  {m === "FIXED" ? "고정 가격" : "트레일링"}
                </button>
              ))}
            </div>
            {stopMode === "TRAIL" ? (
              <div>
                <label className="label" htmlFor={`order-trail-${symbol}`}>
                  {side === "SELL" ? "고점 대비 하락률 (%)" : "저점 대비 반등률 (%)"}
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
                      ? `지금 등록하면 트리거 ${fmt.format(trailPreview)}원부터 시작 · ${
                          side === "SELL" ? "새 고점마다" : "새 저점마다"
                        } 자동으로 따라갑니다`
                      : "현재가를 기준으로 트리거가 정해집니다"
                    : `${TRAIL_BPS_MIN / 100}%~${TRAIL_BPS_MAX / 100}% 사이로 입력하세요`}
                </p>
              </div>
            ) : (
              <div>
                <label className="label" htmlFor={`order-trigger-${symbol}`}>
                  트리거 가격
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
                  placeholder="호가를 클릭해도 입력됩니다"
                />
              </div>
            )}
            {stopMode === "FIXED" && (
              <div className="well grid grid-cols-2 gap-1 p-1" role="group" aria-label="발동 조건">
                {(["AT_OR_BELOW", "AT_OR_ABOVE"] as const).map((d) => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => setDirectionOverride(d)}
                    aria-pressed={triggerDirection === d}
                    className={`rounded-lg py-1.5 text-xs font-medium transition-colors ${
                      triggerDirection === d
                        ? "bg-white/10 text-ink"
                        : "text-ink-muted hover:bg-white/6 hover:text-ink"
                    }`}
                  >
                    {d === "AT_OR_BELOW" ? "이하가 되면" : "이상이 되면"}
                  </button>
                ))}
              </div>
            )}
            <p className="text-[11px] text-ink-faint">
              {stopMode === "TRAIL"
                ? side === "SELL"
                  ? "트레일링 손절"
                  : "트레일링 매수"
                : describeCondition(triggerDirection, side)}{" "}
              · 조건 충족 시 <span className="text-ink-muted">시장가</span>로 접수됩니다. 대기
              중에는 현금·수량을 홀드하지 않습니다.
            </p>
          </div>
        )}

        {type === "LIMIT" && (
          <div>
            <label className="label" htmlFor={`order-price-${symbol}`}>
              가격
              {tickSize != null && (
                <span className="ml-1.5 font-normal text-ink-faint">호가 단위 {fmt.format(tickSize)}원</span>
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
              placeholder="호가를 클릭해도 입력됩니다"
            />
          </div>
        )}

        <div>
          <label className="label" htmlFor={`order-qty-${symbol}`}>
            수량
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
            <span>{side === "BUY" ? "주문 가능 현금 기준" : "매도 가능 수량 기준"}</span>
            {side === "BUY" && buyRefPrice != null && (
              <span className="num">
                {type === "LIMIT" ? "지정가" : "최근가 110%"} {won(buyRefPrice)}
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
                className={`num rounded-lg border py-1.5 text-xs font-medium transition-colors disabled:opacity-40 ${
                  activePct === pct
                    ? side === "BUY"
                      ? "border-up/45 bg-up/15 text-up"
                      : "border-down/45 bg-down/15 text-down"
                    : "border-hairline-soft bg-surface-2/50 text-ink-muted hover:border-hairline hover:text-ink"
                }`}
              >
                {pct === 1 ? "최대" : `${pct * 100}%`}
              </button>
            ))}
          </div>
        </div>

        {/* Balance readout */}
        <div className="well num space-y-1 px-3 py-2.5 text-xs">
          {side === "BUY" ? (
            <>
              <p className="flex items-baseline justify-between gap-2">
                <span className="text-ink-muted">주문 가능 현금</span>
                <span className="font-semibold">
                  {account ? won(account.available) : "불러오는 중"}
                </span>
              </p>
              {account && (
                <p className="flex items-baseline justify-between gap-2 text-ink-faint">
                  <span>예수금</span>
                  <span>
                    {won(account.balance)}
                    {account.holdAmount > 0 && ` · 대기 ${won(account.holdAmount)} 제외`}
                  </span>
                </p>
              )}
              {maxBuyQty != null && (
                <p className="flex items-baseline justify-between gap-2 text-ink-faint">
                  <span>최대 매수 가능</span>
                  <span>{fmt.format(maxBuyQty)}주</span>
                </p>
              )}
            </>
          ) : (
            <>
              <p className="flex items-baseline justify-between gap-2">
                <span className="text-ink-muted">매도 가능 수량</span>
                <span className="font-semibold">{fmt.format(availableQty)}주</span>
              </p>
              <p className="flex items-baseline justify-between gap-2 text-ink-faint">
                <span>보유</span>
                <span>
                  {fmt.format(holding?.qty ?? 0)}주
                  {holding &&
                    holding.holdQty > 0 &&
                    ` · 대기 ${fmt.format(holding.holdQty)}주 제외`}
                </span>
              </p>
            </>
          )}
          {estimate != null && (
            <p className="flex items-baseline justify-between gap-2 border-t border-hairline-soft pt-1.5">
              <span className="text-ink-muted">
                {side === "BUY" && type !== "LIMIT" ? "예상 최대 홀드" : "예상 주문금액"}
              </span>
              <span className="font-semibold text-sky">{won(estimate)}</span>
            </p>
          )}
        </div>

        {/* Advisories */}
        <div className="space-y-1 text-xs">
          {type === "MARKET" && side === "BUY" && (
            <p className="text-ink-faint">시장가 매수는 최근가의 110%까지 증거금이 홀드됩니다</p>
          )}
          {type === "STOP" && stopMode === "FIXED" && triggerAlreadyMet && (
            <p className="text-warn">
              현재가가 이미 조건을 만족합니다. 바로 체결하려면 시장가 주문을 이용하세요.
            </p>
          )}
          {sizingNote && <p className="text-warn">{sizingNote}</p>}
          {type === "LIMIT" && offTick && nearestTick != null && (
            <p className="text-warn">
              호가 단위 {fmt.format(tickSize!)}원에 맞지 않습니다.{" "}
              <button
                type="button"
                className="underline underline-offset-2 hover:text-ink"
                onClick={() => setPrice(String(nearestTick))}
              >
                {fmt.format(nearestTick)}원으로 맞추기
              </button>
            </p>
          )}
          {exceedsAvailableCash && (
            <p className="text-warn">
              입력 수량이 현재 주문 가능 현금을 초과합니다. 접수 시 다시 확인됩니다.
            </p>
          )}
          {exceedsAvailableShares && (
            <p className="text-warn">
              입력 수량이 현재 매도 가능 수량을 초과합니다. 접수 시 다시 확인됩니다.
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
            (type === "STOP" && stopMode === "FIXED" && (!validTrigger || triggerAlreadyMet)) ||
            (type === "STOP" && stopMode === "TRAIL" && !validTrail)
          }
          className={`btn btn-block ${side === "BUY" ? "btn-buy" : "btn-sell"}`}
        >
          {busy
            ? "접수 중…"
            : type === "STOP"
              ? `${side === "BUY" ? "매수" : "매도"} 예약`
              : `${side === "BUY" ? "매수" : "매도"} 주문`}
        </button>
      </div>
    </form>
  );
}
