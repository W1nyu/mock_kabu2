"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api, getToken, won } from "@/lib/api";
import { formatKstTime, MARKET_TIME_ZONE_LABEL } from "@/lib/time";

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
    <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[22rem_1fr]">
      <section className="space-y-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">이체</h1>
          <p className="mt-1 text-sm text-ink-muted">다른 계정으로 가상 현금을 보냅니다.</p>
        </div>

        <form onSubmit={submit} className="glass overflow-hidden">
          <div className="panel-head">
            <span className="panel-title">이체 가능</span>
            <span className="num text-sm font-semibold text-sky">{won(available)}</span>
          </div>

          <div className="space-y-4 p-4">
            <div>
              <label className="label" htmlFor="transfer-to">
                받는 사람 이메일
              </label>
              <input
                id="transfer-to"
                className="field"
                type="email"
                value={toEmail}
                onChange={(e) => setToEmail(e.target.value)}
                placeholder="bot1@bots.local"
              />
            </div>
            <div>
              <label className="label" htmlFor="transfer-amount">
                금액
              </label>
              <input
                id="transfer-amount"
                className="field num"
                inputMode="numeric"
                value={amount}
                onChange={(e) => setAmount(e.target.value.replace(/[^0-9]/g, ""))}
                placeholder="0"
              />
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

            <button disabled={busy || !toEmail || !amount} className="btn btn-primary btn-block">
              {busy ? "이체 중…" : "이체하기"}
            </button>
          </div>
        </form>
      </section>

      <section className="space-y-4">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">현금 원장</h2>
          <p className="mt-1 text-sm text-ink-muted">최근 30건의 잔액 증감 내역입니다.</p>
        </div>

        <div className="glass overflow-hidden">
          <div className="overflow-x-auto">
            <table className="tbl tbl-hover">
              <thead>
                <tr>
                  <th>시각 ({MARKET_TIME_ZONE_LABEL})</th>
                  <th>사유</th>
                  <th className="text-right">증감</th>
                  <th className="text-right">잔액</th>
                </tr>
              </thead>
              <tbody>
                {ledger.map((l) => (
                  <tr key={l.id}>
                    <td className="num whitespace-nowrap text-ink-muted">
                      {formatKstTime(new Date(l.createdAt).getTime())}
                    </td>
                    <td>{REASON_LABEL[l.reason] ?? l.reason}</td>
                    <td
                      className={`num text-right font-medium ${l.delta >= 0 ? "text-up" : "text-down"}`}
                    >
                      {l.delta >= 0 ? "+" : ""}
                      {won(l.delta)}
                    </td>
                    <td className="num text-right text-ink-muted">{won(l.balanceAfter)}</td>
                  </tr>
                ))}
                {ledger.length === 0 && (
                  <tr>
                    <td colSpan={4} className="py-14 text-center text-sm text-ink-faint">
                      원장 내역이 없습니다
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </div>
  );
}
