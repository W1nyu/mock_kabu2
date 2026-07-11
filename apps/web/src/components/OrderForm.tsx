"use client";

import { useEffect, useState } from "react";
import { api, fmt, won } from "@/lib/api";

interface AccountInfo {
  balance: number;
  available: number;
}
interface HoldingRow {
  symbol: string;
  availableQty: number;
}

export default function OrderForm({
  symbol,
  priceHint,
  onPlaced,
}: {
  symbol: string;
  priceHint: number | null;
  onPlaced?: () => void;
}) {
  const [side, setSide] = useState<"BUY" | "SELL">("BUY");
  const [type, setType] = useState<"LIMIT" | "MARKET">("LIMIT");
  const [price, setPrice] = useState("");
  const [qty, setQty] = useState("");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [account, setAccount] = useState<AccountInfo | null>(null);
  const [availableQty, setAvailableQty] = useState(0);

  useEffect(() => {
    if (priceHint != null) setPrice(String(priceHint));
  }, [priceHint]);

  async function refreshLimits() {
    api<AccountInfo>("/account").then(setAccount).catch(() => {});
    api<HoldingRow[]>("/account/holdings")
      .then((rows) => setAvailableQty(rows.find((h) => h.symbol === symbol)?.availableQty ?? 0))
      .catch(() => {});
  }

  useEffect(() => {
    refreshLimits();
    const t = setInterval(refreshLimits, 4000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol]);

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
      refreshLimits();
      onPlaced?.();
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : "주문 실패" });
    } finally {
      setBusy(false);
    }
  }

  const estimate =
    type === "LIMIT" && price && qty ? Number(price) * Number(qty) : null;

  return (
    <form onSubmit={submit} className="rounded-lg border border-neutral-800 bg-neutral-900 p-4">
      <div className="mb-3 grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => setSide("BUY")}
          className={`rounded py-2 text-sm font-bold ${side === "BUY" ? "bg-red-500/90 text-white" : "bg-neutral-800 text-neutral-400"}`}
        >
          매수
        </button>
        <button
          type="button"
          onClick={() => setSide("SELL")}
          className={`rounded py-2 text-sm font-bold ${side === "SELL" ? "bg-blue-500/90 text-white" : "bg-neutral-800 text-neutral-400"}`}
        >
          매도
        </button>
      </div>

      <div className="mb-3 flex gap-3 text-sm">
        {(["LIMIT", "MARKET"] as const).map((t) => (
          <label key={t} className="flex items-center gap-1.5">
            <input type="radio" checked={type === t} onChange={() => setType(t)} />
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
            onChange={(e) => setPrice(e.target.value.replace(/[^0-9]/g, ""))}
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
          onChange={(e) => setQty(e.target.value.replace(/[^0-9]/g, ""))}
        />
      </label>

      <div className="mb-3 space-y-0.5 text-xs text-neutral-400">
        {side === "BUY" ? (
          <p>주문 가능: {won(account?.available ?? 0)}</p>
        ) : (
          <p>매도 가능: {fmt.format(availableQty)}주</p>
        )}
        {estimate != null && <p>예상 주문금액: {won(estimate)}</p>}
        {type === "MARKET" && side === "BUY" && (
          <p>시장가 매수는 최근가의 110%까지 증거금이 홀드됩니다</p>
        )}
      </div>

      {message && (
        <p className={`mb-2 text-sm ${message.ok ? "text-emerald-400" : "text-red-400"}`}>
          {message.text}
        </p>
      )}

      <button
        disabled={busy || !qty || (type === "LIMIT" && !price)}
        className={`w-full rounded py-2 font-bold text-white disabled:opacity-40 ${side === "BUY" ? "bg-red-500 hover:bg-red-400" : "bg-blue-500 hover:bg-blue-400"}`}
      >
        {side === "BUY" ? "매수" : "매도"} 주문
      </button>
    </form>
  );
}
