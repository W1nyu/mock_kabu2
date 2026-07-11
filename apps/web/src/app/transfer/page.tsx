"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api, getToken, won } from "@/lib/api";

interface LedgerRow {
  id: number;
  delta: number;
  balanceAfter: number;
  reason: string;
  createdAt: string;
}

const REASON_LABEL: Record<string, string> = {
  SIGNUP_BONUS: "가입 보너스",
  TRANSFER_IN: "이체 입금",
  TRANSFER_OUT: "이체 출금",
  TRADE_BUY: "매수 체결",
  TRADE_SELL: "매도 체결",
  SEED: "시드",
};

export default function TransferPage() {
  const router = useRouter();
  const [toEmail, setToEmail] = useState("");
  const [amount, setAmount] = useState("");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [available, setAvailable] = useState(0);
  const [ledger, setLedger] = useState<LedgerRow[]>([]);

  function refresh() {
    api<{ available: number }>("/account").then((a) => setAvailable(a.available)).catch(() => {});
    api<LedgerRow[]>("/account/ledger?limit=30").then(setLedger).catch(() => {});
  }

  useEffect(() => {
    if (!getToken()) {
      router.push("/login");
      return;
    }
    refresh();
  }, [router]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      await api("/account/transfer", {
        method: "POST",
        body: { toEmail, amount: Number(amount) },
      });
      setMessage({ ok: true, text: "이체가 완료되었습니다" });
      setAmount("");
      refresh();
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : "이체 실패" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
      <div>
        <h1 className="mb-4 text-xl font-bold">이체</h1>
        <form onSubmit={submit} className="rounded-lg border border-neutral-800 bg-neutral-900 p-4">
          <p className="mb-3 text-sm text-neutral-400">이체 가능: {won(available)}</p>
          <label className="mb-2 block text-sm">
            <span className="text-neutral-400">받는 사람 이메일</span>
            <input
              className="mt-1 w-full rounded border border-neutral-700 bg-neutral-950 px-3 py-2"
              type="email"
              value={toEmail}
              onChange={(e) => setToEmail(e.target.value)}
              placeholder="bot1@bots.local"
            />
          </label>
          <label className="mb-3 block text-sm">
            <span className="text-neutral-400">금액</span>
            <input
              className="mt-1 w-full rounded border border-neutral-700 bg-neutral-950 px-3 py-2 tabular-nums"
              inputMode="numeric"
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^0-9]/g, ""))}
            />
          </label>
          {message && (
            <p className={`mb-2 text-sm ${message.ok ? "text-emerald-400" : "text-red-400"}`}>
              {message.text}
            </p>
          )}
          <button
            disabled={busy || !toEmail || !amount}
            className="w-full rounded bg-amber-500 py-2 font-semibold text-neutral-950 hover:bg-amber-400 disabled:opacity-40"
          >
            이체하기
          </button>
        </form>
      </div>

      <div>
        <h2 className="mb-4 text-xl font-bold">현금 원장</h2>
        <div className="overflow-hidden rounded-lg border border-neutral-800">
          <table className="w-full text-sm">
            <thead className="bg-neutral-900 text-left text-neutral-400">
              <tr>
                <th className="px-3 py-2">시각</th>
                <th className="px-3 py-2">사유</th>
                <th className="px-3 py-2 text-right">증감</th>
                <th className="px-3 py-2 text-right">잔액</th>
              </tr>
            </thead>
            <tbody>
              {ledger.map((l) => (
                <tr key={l.id} className="border-t border-neutral-800">
                  <td className="px-3 py-1.5 text-neutral-400">
                    {new Date(l.createdAt).toLocaleTimeString("ko-KR", { hour12: false })}
                  </td>
                  <td className="px-3 py-1.5">{REASON_LABEL[l.reason] ?? l.reason}</td>
                  <td
                    className={`px-3 py-1.5 text-right tabular-nums ${l.delta >= 0 ? "text-red-400" : "text-blue-400"}`}
                  >
                    {l.delta >= 0 ? "+" : ""}
                    {won(l.delta)}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{won(l.balanceAfter)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
