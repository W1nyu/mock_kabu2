"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { api, fmt, getToken, getUser, won } from "@/lib/api";
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
  lastPrice: number;
  value: number;
}
interface SymbolRow {
  symbol: string;
  name: string;
  lastPrice: number;
  initialPrice: number;
}

export default function DashboardPage() {
  const router = useRouter();
  const [account, setAccount] = useState<AccountInfo | null>(null);
  const [holdings, setHoldings] = useState<HoldingRow[]>([]);
  const [symbols, setSymbols] = useState<SymbolRow[]>([]);

  const refresh = useCallback(() => {
    api<AccountInfo>("/account").then(setAccount).catch(() => {});
    api<HoldingRow[]>("/account/holdings").then(setHoldings).catch(() => {});
    api<SymbolRow[]>("/market/symbols", { auth: false }).then(setSymbols).catch(() => {});
  }, []);

  useEffect(() => {
    if (!getToken()) {
      router.push("/login");
      return;
    }
    refresh();
    const interval = setInterval(refresh, 5000);
    const user = getUser();
    const unsub = user
      ? subscribe([`account:${user.accountId}`], () => refresh())
      : () => {};
    return () => {
      clearInterval(interval);
      unsub();
    };
  }, [refresh, router]);

  const stockValue = holdings.reduce((sum, h) => sum + h.value, 0);
  const total = (account?.balance ?? 0) + stockValue;

  return (
    <div className="space-y-6">
      <section className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Stat label="총 자산" value={won(total)} highlight />
        <Stat label="현금 잔액" value={won(account?.balance ?? 0)} />
        <Stat label="주문 가능" value={won(account?.available ?? 0)} />
        <Stat label="주식 평가금액" value={won(stockValue)} />
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold text-neutral-400">종목</h2>
        <div className="overflow-hidden rounded-lg border border-neutral-800">
          <table className="w-full text-sm">
            <thead className="bg-neutral-900 text-left text-neutral-400">
              <tr>
                <th className="px-4 py-2">종목</th>
                <th className="px-4 py-2 text-right">현재가</th>
                <th className="px-4 py-2 text-right">기준가 대비</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {symbols.map((s) => {
                const change = ((s.lastPrice - s.initialPrice) / s.initialPrice) * 100;
                return (
                  <tr key={s.symbol} className="border-t border-neutral-800 hover:bg-neutral-900">
                    <td className="px-4 py-2">
                      <span className="font-semibold">{s.symbol}</span>{" "}
                      <span className="text-neutral-400">{s.name}</span>
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">{fmt.format(s.lastPrice)}</td>
                    <td
                      className={`px-4 py-2 text-right tabular-nums ${change >= 0 ? "text-red-400" : "text-blue-400"}`}
                    >
                      {change >= 0 ? "▲" : "▼"} {Math.abs(change).toFixed(2)}%
                    </td>
                    <td className="px-4 py-2 text-right">
                      <Link
                        href={`/symbol/${s.symbol}`}
                        className="rounded bg-neutral-800 px-3 py-1 text-xs hover:bg-neutral-700"
                      >
                        거래하기
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold text-neutral-400">보유 자산</h2>
        {holdings.length === 0 ? (
          <p className="rounded-lg border border-neutral-800 p-4 text-sm text-neutral-500">
            보유 종목이 없습니다. 종목을 골라 첫 매수를 해보세요.
          </p>
        ) : (
          <div className="overflow-hidden rounded-lg border border-neutral-800">
            <table className="w-full text-sm">
              <thead className="bg-neutral-900 text-left text-neutral-400">
                <tr>
                  <th className="px-4 py-2">종목</th>
                  <th className="px-4 py-2 text-right">보유 수량</th>
                  <th className="px-4 py-2 text-right">매도 대기</th>
                  <th className="px-4 py-2 text-right">현재가</th>
                  <th className="px-4 py-2 text-right">평가금액</th>
                </tr>
              </thead>
              <tbody>
                {holdings.map((h) => (
                  <tr key={h.symbol} className="border-t border-neutral-800">
                    <td className="px-4 py-2 font-semibold">
                      <Link href={`/symbol/${h.symbol}`} className="hover:text-amber-400">
                        {h.symbol}
                      </Link>
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">{fmt.format(h.qty)}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-neutral-400">
                      {fmt.format(h.holdQty)}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">{fmt.format(h.lastPrice)}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{won(h.value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function Stat({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-4">
      <p className="text-xs text-neutral-400">{label}</p>
      <p className={`mt-1 text-lg font-bold tabular-nums ${highlight ? "text-amber-400" : ""}`}>
        {value}
      </p>
    </div>
  );
}
