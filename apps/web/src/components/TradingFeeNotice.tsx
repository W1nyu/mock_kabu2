"use client";

import { tradeNotional, tradingFee, TRADING_FEES_EFFECTIVE_AT } from "@mock-kabu/shared";
import { useEffect, useState } from "react";
import { won } from "@/lib/api";
import { useT } from "@/lib/i18n";

export default function TradingFeeNotice({ symbol, price, qty, leverage, exempt = false }: {
  symbol: string; price: number | null; qty: number; leverage?: number | null; exempt?: boolean;
}) {
  const t = useT();
  const [active, setActive] = useState(false);
  useEffect(() => {
    const delay = TRADING_FEES_EFFECTIVE_AT - Date.now();
    if (delay <= 0) { setActive(true); return; }
    const timer = setTimeout(() => setActive(true), Math.min(delay, 2_147_483_647));
    return () => clearTimeout(timer);
  }, []);
  if (!active || exempt) return null;
  const valid = price != null && Number.isSafeInteger(price) && price > 0 && Number.isSafeInteger(qty) && qty > 0;
  const fee = valid ? Number(tradingFee(tradeNotional(symbol, price!, qty), TRADING_FEES_EFFECTIVE_AT)) : null;
  return (
    <div className="space-y-1 text-xs text-ink-muted">
      <p className="flex justify-between gap-2"><span>{t("예상 수수료 (매수·매도 각각 0.01%)")}</span><span className="num tabular-nums">{fee == null ? "—" : won(fee)}</span></p>
      {leverage != null && <p>{t("{n}배: 증거금 대비 각 {pct}%", { n: leverage, pct: (0.01 * leverage).toFixed(2) })}</p>}
      <p className="text-[11px] text-ink-faint">{t("실제 체결금액 기준 · 체결별 원 미만 올림 · 부분 체결 시 합계가 달라질 수 있습니다.")}</p>
    </div>
  );
}
