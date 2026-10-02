"use client";

import { futureDef, type ConditionalOrderDto } from "@mock-kabu/shared";
import { useCallback, useEffect, useState } from "react";
import { api, newIdempotencyKey } from "@/lib/api";
import { fmtFuture, toFutureUnits, unitsToInput } from "@/lib/futures";
import { useT } from "@/lib/i18n";

/**
 * 보유 포지션 관리 — 시장가 전량 청산, 손절·익절(OCO) 예약, 걸려 있는 예약 취소.
 * 청산·손절·익절 주문은 포지션을 줄이는 주문이라 증거금이 필요 없다(서버가 판정).
 * 손절·익절은 한쪽이 발동하면 다른 쪽이 자동 취소되고, 발동하면 전량 시장가로 청산한다.
 */
export default function FuturesPositionActions({
  symbol,
  qty,
  positionSide,
  closableQty,
  markPrice,
  avgPrice,
  refreshKey,
  onChanged,
}: {
  symbol: string;
  /** 포지션 수량(롱 +, 숏 −) */
  qty: number;
  /** LONG/SHORT(양방향), NET(봇) — 청산 주문에 그대로 싣는다 */
  positionSide: "LONG" | "SHORT" | "NET";
  /** 지금 청산 주문을 낼 수 있는 계약 수 */
  closableQty: number;
  markPrice: number;
  /** 평균 진입가(정수 단위) — 손절·익절 % 빠른 입력의 기준 */
  avgPrice: number;
  refreshKey: number;
  onChanged: () => void;
}) {
  const t = useT();
  const def = futureDef(symbol)!;
  const long = qty > 0;
  const closeSide = long ? "SELL" : "BUY";
  const hedge = positionSide !== "NET";
  // 0 = 지우고 다시 입력하는 중(빈 칸)
  const [closeQty, setCloseQty] = useState(1);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [stopText, setStopText] = useState("");
  const [takeText, setTakeText] = useState("");
  const [waiting, setWaiting] = useState<ConditionalOrderDto[]>([]);

  useEffect(() => setCloseQty((q) => (q === 0 ? 0 : Math.max(1, Math.min(q, closableQty || 1)))), [closableQty]);

  const loadWaiting = useCallback(() => {
    api<ConditionalOrderDto[]>(`/orders/conditional?symbol=${symbol}&status=WAITING&limit=20`)
      .then((rows) => setWaiting(rows.filter((row) => row.side === closeSide)))
      .catch(() => {});
  }, [symbol, closeSide]);
  useEffect(loadWaiting, [loadWaiting, refreshKey]);

  async function run(action: () => Promise<unknown>, ok: string) {
    setBusy(true);
    setMessage(null);
    try {
      await action();
      setMessage({ ok: true, text: ok });
      loadWaiting();
      onChanged();
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : t("요청에 실패했습니다") });
    } finally {
      setBusy(false);
    }
  }

  function closePart() {
    const n = Math.min(closeQty, closableQty);
    if (n < 1) return;
    void run(
      () =>
        api("/orders", {
          method: "POST",
          headers: { "idempotency-key": newIdempotencyKey() },
          body: { symbol, side: closeSide, type: "MARKET", qty: n, ...(hedge ? { positionSide } : {}) },
        }),
      t("{n}계약 시장가 청산을 접수했습니다", { n }),
    );
  }

  // 롱: 손절은 아래, 익절은 위. 숏은 반대. 둘 다면 (아래, 위) OCO, 하나만이면 단일 예약.
  const stop = stopText.trim() ? toFutureUnits(symbol, stopText) : null;
  const take = takeText.trim() ? toFutureUnits(symbol, takeText) : null;
  const lower = long ? stop : take;
  const upper = long ? take : stop;
  const ocoValid =
    (lower != null || upper != null) && (lower == null || lower < markPrice) && (upper == null || upper > markPrice);
  const legLabel = stop != null && take != null ? t("손절·익절") : stop != null ? t("손절") : take != null ? t("익절") : t("손절·익절");

  function placeOco() {
    if (!ocoValid) return;
    const request =
      lower != null && upper != null
        ? () =>
            api("/orders/conditional/oco", {
              method: "POST",
              body: { symbol, side: closeSide, qty: Math.abs(qty), lowerPrice: lower, upperPrice: upper },
            })
        : () =>
            api("/orders/conditional", {
              method: "POST",
              body: {
                symbol,
                side: closeSide,
                qty: Math.abs(qty),
                direction: lower != null ? "AT_OR_BELOW" : "AT_OR_ABOVE",
                triggerPrice: lower ?? upper,
                orderType: "MARKET",
              },
            });
    void run(request, t("{leg}을 걸었습니다", { leg: legLabel }));
  }

  const tick = unitsToInput(symbol, def.tickUnits);
  /** 평균가 기준 pct% 손실/이익 가격을 틱에 맞춰 채운다. 롱 손절은 아래, 숏 손절은 위. */
  function preset(kind: "stop" | "take", pct: number) {
    const sign = (kind === "stop") === long ? -1 : 1;
    const target = Math.round((avgPrice * (1 + (sign * pct) / 100)) / def.tickUnits) * def.tickUnits;
    const text = unitsToInput(symbol, Math.max(def.tickUnits, target));
    if (kind === "stop") setStopText(text);
    else setTakeText(text);
  }
  const stopHint = long ? t("현재가보다 낮게") : t("현재가보다 높게");
  const takeHint = long ? t("현재가보다 높게") : t("현재가보다 낮게");

  return (
    <div className="space-y-3 border-t border-hairline-soft pt-3">
      <div>
        <div className="mb-1.5 flex items-center justify-between text-xs text-ink-muted">
          <span>{t("청산 수량 (계약)")}</span>
          <span className="num text-[11px] text-ink-faint">
            {t("청산 가능 {n}계약", { n: closableQty })}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <input
            inputMode="numeric"
            value={closeQty === 0 ? "" : closeQty}
            placeholder="0"
            onChange={(e) =>
              setCloseQty(Math.min(closableQty || 1, Number(e.target.value.replace(/\D/g, "")) || 0))
            }
            className="num w-20 rounded-lg border border-hairline bg-surface-2/60 px-2.5 py-1.5 text-center"
          />
          <div className="grid flex-1 grid-cols-4 gap-1">
            {[0.25, 0.5, 0.75, 1].map((pct) => (
              <button
                key={pct}
                type="button"
                disabled={closableQty < 1}
                onClick={() => setCloseQty(Math.max(1, Math.floor(closableQty * pct)))}
                className="num rounded-md py-1 text-[11px] ring-1 ring-hairline ring-inset disabled:opacity-40"
              >
                {pct * 100}%
              </button>
            ))}
          </div>
        </div>
        <button
          type="button"
          disabled={busy || closableQty < 1 || closeQty < 1}
          onClick={closePart}
          className={`mt-2 min-h-10 w-full rounded-xl text-sm font-semibold text-white disabled:opacity-50 ${long ? "bg-down" : "bg-up"}`}
        >
          {t("{n}계약 시장가 청산", { n: Math.min(closeQty, closableQty) })}
        </button>
      </div>

      <div>
        <p className="mb-1.5 text-xs text-ink-muted">{t("손절·익절 (하나만 입력해도 됨 · 둘 다면 한쪽 발동 시 다른 쪽 취소 · 전량 시장가 청산)")}</p>
        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className="text-[11px] text-ink-faint">{t("손절가")} · {stopHint}</span>
            <input
              inputMode="decimal"
              value={stopText}
              placeholder={tick}
              onChange={(e) => setStopText(e.target.value)}
              className="num mt-1 w-full rounded-lg border border-hairline bg-surface-2/60 px-2.5 py-1.5 text-right"
            />
          </label>
          <label className="block">
            <span className="text-[11px] text-ink-faint">{t("익절가")} · {takeHint}</span>
            <input
              inputMode="decimal"
              value={takeText}
              placeholder={tick}
              onChange={(e) => setTakeText(e.target.value)}
              className="num mt-1 w-full rounded-lg border border-hairline bg-surface-2/60 px-2.5 py-1.5 text-right"
            />
          </label>
        </div>
        <div className="mt-1.5 grid grid-cols-2 gap-2 text-[11px]">
          {(["stop", "take"] as const).map((kind) => (
            <div key={kind} className="flex gap-1">
              {[1, 3, 5].map((pct) => (
                <button
                  key={pct}
                  type="button"
                  onClick={() => preset(kind, pct)}
                  className={`num flex-1 rounded-md py-1 ring-1 ring-hairline ring-inset ${kind === "stop" ? "text-down" : "text-up"}`}
                  title={kind === "stop" ? t("평균가 대비 손실 {pct}%", { pct }) : t("평균가 대비 이익 {pct}%", { pct })}
                >
                  {kind === "stop" ? "−" : "+"}
                  {pct}%
                </button>
              ))}
            </div>
          ))}
        </div>
        <button type="button" disabled={busy || !ocoValid} onClick={placeOco} className="btn btn-ghost btn-sm mt-2 w-full">
          {t("{leg} 걸기", { leg: legLabel })}
        </button>
      </div>

      {waiting.length > 0 && (
        <ul className="space-y-1.5">
          {waiting.map((row) => (
            <li key={row.id} className="num flex items-center justify-between gap-2 text-[12px]">
              <span>
                <span className="mr-1.5 rounded bg-surface-3/60 px-1.5 py-0.5 text-[10px] font-semibold text-ink-muted">
                  {(row.direction === "AT_OR_BELOW") === long ? t("손절") : t("익절")}
                </span>
                {fmtFuture(symbol, row.triggerPrice)} {row.direction === "AT_OR_BELOW" ? t("이하") : t("이상")} · {t("{n}계약", { n: row.qty })}
              </span>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={busy}
                onClick={() => void run(() => api(`/orders/conditional/${row.id}`, { method: "DELETE" }), t("예약을 취소했습니다"))}
              >
                {t("취소|동작")}
              </button>
            </li>
          ))}
        </ul>
      )}

      {message && <p className={`text-[12px] ${message.ok ? "text-ok" : "text-down"}`}>{message.text}</p>}
    </div>
  );
}
