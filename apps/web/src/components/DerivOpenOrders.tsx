"use client";

import { futureDef, isOnTick, optionDef } from "@mock-kabu/shared";
import { useCallback, useEffect, useState } from "react";
import { api, fmt, getUser } from "@/lib/api";
import { ACCOUNT_REFRESH_DEBOUNCE_MS, debounce } from "@/lib/debounce";
import { fmtFuture } from "@/lib/futures";
import { serverText, useT } from "@/lib/i18n";
import { useOrderCancel } from "@/lib/order-cancel";
import { subscribe } from "@/lib/socket";
import { everyVisible } from "@/lib/visible-interval";

interface LiveOrder {
  id: string;
  side: "BUY" | "SELL";
  type: string;
  price: number | null;
  qty: number;
  filledQty: number;
}

/** 선물·옵션 가격 규격 — 저장 가격(정수 단위) = 실제 가격 × priceScale */
function scaleOf(
  symbol: string,
): { priceScale: number; decimals: number; tickUnits: number } | null {
  return futureDef(symbol) ?? optionDef(symbol) ?? null;
}

/** 화면 가격 "12.35" → 정수 단위 1235. 소수 자릿수를 넘거나 숫자가 아니면 null. */
function toUnits(text: string, scale: { priceScale: number; decimals: number }): number | null {
  if (!/^\d+(\.\d*)?$/.test(text)) return null;
  const [, frac = ""] = text.split(".");
  if (frac.length > scale.decimals) return null;
  return Math.round(Number(text) * scale.priceScale);
}

function toText(units: number, scale: { priceScale: number; decimals: number }): string {
  return (units / scale.priceScale).toFixed(scale.decimals);
}

/**
 * 선물·옵션 한 종목의 내 미체결 주문 — 정정(가격·남은 수량, 취소 후 재접수)·취소·전체 취소.
 * 계좌 채널 알림으로 바로 다시 읽고, 놓친 알림은 15초 폴백으로 메운다. 미체결이 없으면 그리지 않는다.
 */
export default function DerivOpenOrders({
  symbol,
  refreshKey,
  priceHint,
  onChanged,
}: {
  symbol: string;
  refreshKey?: number;
  /** 호가창 클릭(정수 단위) — 정정 중인 주문이 있으면 그 가격 칸에 넣는다. */
  priceHint?: { price: number; seq: number } | null;
  /** 취소·정정 뒤(증거금·주문 가능 금액이 바뀐다) */
  onChanged?: () => void;
}) {
  const t = useT();
  const scale = scaleOf(symbol);
  const [orders, setOrders] = useState<LiveOrder[]>([]);
  const [editing, setEditing] = useState<{ id: string; price: string; qty: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    if (!getUser()) return;
    api<LiveOrder[]>(`/orders?symbol=${symbol}&status=live&limit=50`)
      .then(setOrders)
      .catch(() => {});
  }, [symbol]);

  const afterCancel = useCallback(() => {
    refresh();
    onChanged?.();
  }, [refresh, onChanged]);
  // 실패 사유(점검 중 503, 이미 체결 등)를 보여 주고, 접수된 취소는 목록에서 빠질 때까지 "취소 중"으로 둔다.
  const { pending: cancelling, error: cancelError, setError: setCancelError, cancel: requestCancel } = useOrderCancel(
    orders.map((o) => o.id),
    afterCancel,
  );
  const error = editError ?? cancelError;
  const setError = (message: string | null) => {
    setEditError(message);
    setCancelError(null);
  };

  useEffect(() => {
    refresh();
  }, [refresh, refreshKey]);

  useEffect(() => {
    const user = getUser();
    const refreshSoon = debounce(refresh, ACCOUNT_REFRESH_DEBOUNCE_MS);
    const unsub = user ? subscribe([`account:${user.accountId}`], () => refreshSoon()) : () => {};
    const stop = everyVisible(refresh, 15_000);
    return () => {
      unsub();
      refreshSoon.cancel();
      stop();
    };
  }, [refresh]);

  useEffect(() => {
    if (priceHint == null || !scale) return;
    setEditing((current) =>
      current ? { ...current, price: toText(priceHint.price, scale) } : current,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [priceHint?.seq]);

  // 정정 중이던 주문이 체결·취소로 사라지면 편집을 닫는다.
  useEffect(() => {
    if (editing && !orders.some((o) => o.id === editing.id)) setEditing(null);
  }, [orders, editing]);

  if (!scale || orders.length === 0) return null;

  const after = () => {
    refresh();
    onChanged?.();
  };

  function cancel(id: string) {
    setEditError(null);
    void requestCancel(id, t("취소 실패"));
  }

  async function cancelAll() {
    setBusy(true);
    setError(null);
    const results = await Promise.allSettled(
      orders.map((o) => api(`/orders/${o.id}`, { method: "DELETE" })),
    );
    const failed = results.filter((r) => r.status === "rejected").length;
    if (failed > 0)
      setError(t("{n}건은 취소하지 못했습니다(이미 체결됐을 수 있습니다)", { n: failed }));
    setBusy(false);
    after();
  }

  async function submitEdit() {
    if (!editing || !scale) return;
    const price = toUnits(editing.price, scale);
    if (price == null) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ amended: boolean; reason: string | null }>(
        `/orders/${editing.id}`,
        {
          method: "PATCH",
          body: { price, qty: Number(editing.qty) },
        },
      );
      if (!result.amended)
        setError(result.reason ? serverText(result.reason) : t("정정하지 못했습니다"));
      else setEditing(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("정정 실패"));
    } finally {
      setBusy(false);
      after();
    }
  }

  return (
    <section className="glass overflow-hidden">
      <div className="panel-head">
        <span className="panel-title">{t("미체결 주문")}</span>
        <span className="chip">{orders.length}</span>
        {orders.length > 1 && (
          <button
            type="button"
            className="btn btn-ghost btn-sm ml-auto"
            disabled={busy}
            onClick={cancelAll}
          >
            {t("전체 취소")}
          </button>
        )}
      </div>
      <ul className="num text-xs">
        {orders.map((o) => {
          const remaining = o.qty - o.filledQty;
          const sideLabel = (
            <span
              className={`w-8 shrink-0 font-semibold ${o.side === "BUY" ? "text-up" : "text-down"}`}
            >
              {o.side === "BUY" ? t("매수") : t("매도")}
            </span>
          );
          if (editing?.id === o.id) {
            const price = toUnits(editing.price, scale);
            const qty = Number(editing.qty);
            const priceOk = price != null && price > 0 && isOnTick(price, scale.tickUnits);
            const qtyOk = Number.isSafeInteger(qty) && qty > 0 && qty <= remaining;
            const unchanged = price === o.price && qty === remaining;
            return (
              <li
                key={o.id}
                className="space-y-1.5 border-b border-hairline-soft bg-sky/4 px-4 py-2 last:border-b-0"
              >
                <div className="flex items-center gap-2">
                  {sideLabel}
                  <span className="text-ink-faint">{t("정정")}</span>
                  <input
                    className="field ml-auto w-24 py-1 text-xs"
                    inputMode="decimal"
                    aria-label={t("정정 가격")}
                    value={editing.price}
                    onChange={(e) =>
                      setEditing({ ...editing, price: e.target.value.replace(/[^0-9.]/g, "") })
                    }
                  />
                  <input
                    className="field w-14 py-1 text-xs"
                    inputMode="numeric"
                    aria-label={t("정정 수량")}
                    value={editing.qty}
                    onChange={(e) =>
                      setEditing({ ...editing, qty: e.target.value.replace(/[^0-9]/g, "") })
                    }
                  />
                  <button
                    type="button"
                    onClick={submitEdit}
                    disabled={busy || !priceOk || !qtyOk || unchanged}
                    className="btn btn-primary btn-sm shrink-0"
                  >
                    {busy ? t("정정 중…") : t("확인")}
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditing(null)}
                    className="btn btn-ghost btn-sm shrink-0"
                  >
                    {t("닫기")}
                  </button>
                </div>
                <p className="text-[11px] text-ink-faint">
                  {t("호가창을 누르면 가격이 들어갑니다 · 남은 {n}계약 이하 · 호가 단위 {tick}", {
                    n: fmt.format(remaining),
                    tick: fmtFuture(symbol, scale.tickUnits),
                  })}
                </p>
              </li>
            );
          }
          return (
            <li
              key={o.id}
              className="flex items-center gap-2 border-b border-hairline-soft px-4 py-2 last:border-b-0"
            >
              {sideLabel}
              <span>{t("{n}계약", { n: fmt.format(remaining) })}</span>
              {o.filledQty > 0 && (
                <span className="text-ink-faint">
                  ({t("{n}계약 체결", { n: fmt.format(o.filledQty) })})
                </span>
              )}
              <span className="ml-auto text-ink-muted">
                {o.price == null ? t("시장가") : fmtFuture(symbol, o.price)}
              </span>
              {o.type === "LIMIT" && o.price != null && (
                <button
                  type="button"
                  onClick={() => {
                    setEditing({
                      id: o.id,
                      price: toText(o.price!, scale),
                      qty: String(remaining),
                    });
                    setError(null);
                  }}
                  className="btn btn-ghost btn-sm shrink-0"
                  title={t("가격·남은 수량을 고쳐 다시 접수합니다")}
                >
                  {t("정정")}
                </button>
              )}
              <button
                type="button"
                onClick={() => cancel(o.id)}
                disabled={cancelling[o.id] != null}
                className="btn btn-ghost btn-sm shrink-0"
              >
                {cancelling[o.id] != null ? t("취소 중…") : t("취소|동작")}
              </button>
            </li>
          );
        })}
      </ul>
      {error && (
        <p className="border-t border-hairline-soft px-4 py-2 text-[11px] text-warn">{error}</p>
      )}
    </section>
  );
}
