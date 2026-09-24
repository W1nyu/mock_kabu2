"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api, getToken, getUser, won } from "@/lib/api";
import { formatKstTime, MARKET_TIME_ZONE_LABEL } from "@/lib/time";

interface LedgerRow {
  id: number;
  delta: number;
  deltaExact?: string;
  balanceAfter: number;
  balanceAfterExact?: string;
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
  const [toNickname, setToNickname] = useState("");
  const [amount, setAmount] = useState("");
  const [adminPassword, setAdminPassword] = useState("");
  const [isAdmin, setIsAdmin] = useState(false);
  const [transferMode, setTransferMode] = useState<"one" | "all">("one");
  const [bulkConfirmed, setBulkConfirmed] = useState(false);
  const [bulkRequestId, setBulkRequestId] = useState<string | null>(null);
  const [recipientCount, setRecipientCount] = useState(0);
  const [recipients, setRecipients] = useState<{ id: string; nickname: string }[]>([]);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [available, setAvailable] = useState("0");
  const [ledger, setLedger] = useState<LedgerRow[]>([]);

  function refresh() {
    api<{ available: number; availableExact?: string }>("/account").then((a) => setAvailable(a.availableExact ?? String(a.available))).catch(() => {});
    api<LedgerRow[]>("/account/ledger?limit=30").then(setLedger).catch(() => {});
  }

  useEffect(() => {
    if (!getToken()) {
      router.push("/login");
      return;
    }
    setIsAdmin(getUser()?.isAdmin === true);
    refresh();
  }, [router]);

  useEffect(() => {
    if (!isAdmin) return;
    let active = true;
    const timer = window.setTimeout(() => {
      api<{ total: number; rows: { id: string; nickname: string }[] }>(`/account/recipients?q=${encodeURIComponent(toNickname)}`)
        .then((data) => { if (active) { setRecipients(data.rows); setRecipientCount(data.total); } })
        .catch(() => { if (active) setRecipients([]); });
    }, 200);
    return () => { active = false; window.clearTimeout(timer); };
  }, [isAdmin, toNickname]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      if (isAdmin && transferMode === "all") {
        const requestId = bulkRequestId ?? crypto.randomUUID();
        setBulkRequestId(requestId);
        const result = await api<{ recipients: number; total: string }>("/account/transfer-all", {
          method: "POST", body: { requestId, amountEach: Number(amount), adminPassword },
        });
        setMessage({ ok: true, text: `${result.recipients}명에게 총 ${won(BigInt(result.total))} 이체했습니다` });
        setBulkRequestId(null);
        setBulkConfirmed(false);
      } else {
        await api("/account/transfer", {
          method: "POST",
          body: { toNickname: toNickname.trim(), amount: Number(amount), ...(isAdmin ? { adminPassword } : {}) },
        });
        setMessage({ ok: true, text: "이체가 완료되었습니다" });
      }
      setAmount("");
      refresh();
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : "이체 실패" });
    } finally {
      setAdminPassword("");
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
            <span className="num text-sm font-semibold text-sky">{won(BigInt(available))}</span>
          </div>

          <div className="space-y-4 p-4">
            {isAdmin && <div className="flex gap-2" role="group" aria-label="이체 대상">
              <button type="button" aria-pressed={transferMode === "one"} onClick={() => setTransferMode("one")}
                className={`btn btn-sm ${transferMode === "one" ? "btn-primary" : ""}`}>한 명에게</button>
              <button type="button" aria-pressed={transferMode === "all"} onClick={() => setTransferMode("all")}
                className={`btn btn-sm ${transferMode === "all" ? "btn-primary" : ""}`}>전체 투자자에게</button>
            </div>}
            {transferMode === "one" && <div>
              <label className="label" htmlFor="transfer-to">
                받는 사람 닉네임
              </label>
              <input
                id="transfer-to"
                className="field"
                autoComplete="off"
                value={toNickname}
                onChange={(e) => setToNickname(e.target.value)}
                placeholder="랭킹에 보이는 닉네임 그대로"
                list={isAdmin ? "investor-recipients" : undefined}
              />
              {isAdmin && <>
                <datalist id="investor-recipients">{recipients.map((user) => <option key={user.id} value={user.nickname} />)}</datalist>
                <p className="mt-1 text-xs text-ink-muted">전체 투자자 중 닉네임으로 검색해 선택할 수 있습니다.</p>
              </>}
            </div>}

            {isAdmin && <div>
              <label className="label" htmlFor="transfer-admin-password">관리자 비밀번호 재확인</label>
              <input id="transfer-admin-password" className="field" type="password" autoComplete="off"
                value={adminPassword} onChange={(event) => setAdminPassword(event.target.value)} />
            </div>}
            <div>
              <label className="label" htmlFor="transfer-amount">
                {isAdmin && transferMode === "all" ? "1인당 금액" : "금액"}
              </label>
              <input
                id="transfer-amount"
                className="field num"
                inputMode="numeric"
                value={amount}
                onChange={(e) => { setAmount(e.target.value.replace(/[^0-9]/g, "")); setBulkConfirmed(false); setBulkRequestId(null); }}
                placeholder="0"
              />
            </div>

            {isAdmin && transferMode === "all" && <div className="rounded-control border border-warn/30 bg-warn/8 p-3 text-sm">
              <p>봇·관리자·테스트 계정을 제외한 현재 투자자 {recipientCount}명에게 동일한 금액을 지급합니다.</p>
              <p className="num mt-1">예상 총액: {won(BigInt(amount || "0") * BigInt(recipientCount))}</p>
              <label className="mt-2 flex cursor-pointer items-center gap-2">
                <input type="checkbox" checked={bulkConfirmed} onChange={(event) => setBulkConfirmed(event.target.checked)} />
                전체 지급 대상과 예상 총액을 확인했습니다
              </label>
            </div>}

            {message && (
              <p
                className={`rounded-control border px-3 py-2 text-sm ${
                  message.ok ? "border-ok/30 bg-ok/8 text-ok" : "border-up/30 bg-up/8 text-up"
                }`}
              >
                {message.text}
              </p>
            )}

            <button disabled={busy || !amount || !Number.isSafeInteger(Number(amount)) || Number(amount) <= 0 ||
              (transferMode === "one" && !toNickname.trim()) ||
              (isAdmin && !adminPassword) || (transferMode === "all" && (!bulkConfirmed || recipientCount === 0))}
              className="btn btn-primary btn-block">
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
                      {won(BigInt(l.deltaExact ?? String(l.delta)))}
                    </td>
                    <td className="num text-right text-ink-muted">{won(BigInt(l.balanceAfterExact ?? String(l.balanceAfter)))}</td>
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
