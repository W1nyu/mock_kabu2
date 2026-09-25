"use client";

import { futureDef, type ConditionalOrderDto } from "@mock-kabu/shared";
import { useCallback, useEffect, useState } from "react";
import { api, newIdempotencyKey } from "@/lib/api";
import { fmtFuture, toFutureUnits, unitsToInput } from "@/lib/futures";

/**
 * 보유 포지션 관리 — 시장가 전량 청산, 손절·익절(OCO) 예약, 걸려 있는 예약 취소.
 * 청산·손절·익절 주문은 포지션을 줄이는 주문이라 증거금이 필요 없다(서버가 판정).
 * 손절·익절은 한쪽이 발동하면 다른 쪽이 자동 취소되고, 발동하면 전량 시장가로 청산한다.
 */
export default function FuturesPositionActions({
  symbol,
  qty,
  markPrice,
  refreshKey,
  onChanged,
}: {
  symbol: string;
  /** 포지션 수량(롱 +, 숏 −) */
  qty: number;
  markPrice: number;
  refreshKey: number;
  onChanged: () => void;
}) {
  const def = futureDef(symbol)!;
  const long = qty > 0;
  const closeSide = long ? "SELL" : "BUY";
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [stopText, setStopText] = useState("");
  const [takeText, setTakeText] = useState("");
  const [waiting, setWaiting] = useState<ConditionalOrderDto[]>([]);

  const loadWaiting = useCallback(() => {
    api<ConditionalOrderDto[]>(`/orders/conditional?symbol=${symbol}&status=WAITING&limit=20`)
      .then(setWaiting)
      .catch(() => {});
  }, [symbol]);
  useEffect(loadWaiting, [loadWaiting, refreshKey]);

  // 두 번 눌러야 청산 — 브라우저 확인 창을 쓰지 않고 실수로 누르는 것만 막는다. 4초 지나면 풀린다.
  useEffect(() => {
    if (!confirming) return;
    const id = window.setTimeout(() => setConfirming(false), 4_000);
    return () => window.clearTimeout(id);
  }, [confirming]);

  async function run(action: () => Promise<unknown>, ok: string) {
    setBusy(true);
    setMessage(null);
    try {
      await action();
      setMessage({ ok: true, text: ok });
      loadWaiting();
      onChanged();
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : "요청에 실패했습니다" });
    } finally {
      setBusy(false);
    }
  }

  function closeAll() {
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setConfirming(false);
    void run(
      () =>
        api("/orders", {
          method: "POST",
          headers: { "idempotency-key": newIdempotencyKey() },
          body: { symbol, side: closeSide, type: "MARKET", qty: Math.abs(qty) },
        }),
      `${Math.abs(qty)}계약 시장가 청산을 접수했습니다`,
    );
  }

  // 롱: 손절은 아래, 익절은 위. 숏은 반대. OCO는 (아래, 위) 한 쌍으로 등록한다.
  const stop = toFutureUnits(symbol, stopText);
  const take = toFutureUnits(symbol, takeText);
  const lower = long ? stop : take;
  const upper = long ? take : stop;
  const ocoValid = lower != null && upper != null && lower < markPrice && upper > markPrice;

  function placeOco() {
    if (!ocoValid) return;
    void run(
      () =>
        api("/orders/conditional/oco", {
          method: "POST",
          body: { symbol, side: closeSide, qty: Math.abs(qty), lowerPrice: lower, upperPrice: upper },
        }),
      "손절·익절을 걸었습니다",
    );
  }

  const tick = unitsToInput(symbol, def.tickUnits);
  const stopHint = long ? "현재가보다 낮게" : "현재가보다 높게";
  const takeHint = long ? "현재가보다 높게" : "현재가보다 낮게";

  return (
    <div className="space-y-3 border-t border-hairline-soft pt-3">
      <button
        type="button"
        disabled={busy}
        onClick={closeAll}
        className={`min-h-10 w-full rounded-xl text-sm font-semibold disabled:opacity-50 ${
          confirming ? (long ? "bg-down text-white" : "bg-up text-white") : "ring-1 ring-hairline ring-inset"
        }`}
      >
        {confirming ? "한 번 더 누르면 시장가로 전량 청산" : `${Math.abs(qty)}계약 전량 청산 (시장가)`}
      </button>

      <div>
        <p className="mb-1.5 text-xs text-ink-muted">손절·익절 (한쪽이 발동하면 다른 쪽은 취소, 전량 시장가 청산)</p>
        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className="text-[11px] text-ink-faint">손절가 · {stopHint}</span>
            <input
              inputMode="decimal"
              value={stopText}
              placeholder={tick}
              onChange={(e) => setStopText(e.target.value)}
              className="num mt-1 w-full rounded-lg border border-hairline bg-surface-2/60 px-2.5 py-1.5 text-right"
            />
          </label>
          <label className="block">
            <span className="text-[11px] text-ink-faint">익절가 · {takeHint}</span>
            <input
              inputMode="decimal"
              value={takeText}
              placeholder={tick}
              onChange={(e) => setTakeText(e.target.value)}
              className="num mt-1 w-full rounded-lg border border-hairline bg-surface-2/60 px-2.5 py-1.5 text-right"
            />
          </label>
        </div>
        <button type="button" disabled={busy || !ocoValid} onClick={placeOco} className="btn btn-ghost btn-sm mt-2 w-full">
          손절·익절 걸기
        </button>
      </div>

      {waiting.length > 0 && (
        <ul className="space-y-1.5">
          {waiting.map((row) => (
            <li key={row.id} className="num flex items-center justify-between gap-2 text-[12px]">
              <span>
                <span className="mr-1.5 rounded bg-surface-3/60 px-1.5 py-0.5 text-[10px] font-semibold text-ink-muted">
                  {(row.direction === "AT_OR_BELOW") === long ? "손절" : "익절"}
                </span>
                {fmtFuture(symbol, row.triggerPrice)} {row.direction === "AT_OR_BELOW" ? "이하" : "이상"} · {row.qty}계약
              </span>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={busy}
                onClick={() => void run(() => api(`/orders/conditional/${row.id}`, { method: "DELETE" }), "예약을 취소했습니다")}
              >
                취소
              </button>
            </li>
          ))}
        </ul>
      )}

      {message && <p className={`text-[12px] ${message.ok ? "text-ok" : "text-down"}`}>{message.text}</p>}
    </div>
  );
}
