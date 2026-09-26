"use client";

import { ALL_OPTIONS, optionDef } from "@mock-kabu/shared";
import Link from "next/link";
import { use, useCallback, useEffect, useState } from "react";
import AssetNews from "@/components/AssetNews";
import FuturesBook from "@/components/FuturesBook";
import OptionOrderPanel from "@/components/OptionOrderPanel";
import UnitCandleChart from "@/components/UnitCandleChart";
import { api, getUser, won } from "@/lib/api";
import type { FuturesAccount } from "@/lib/futures";
import { fmtOption, fmtStrike, optionLabel, timeLeft, type OptionRow } from "@/lib/options";
import { subscribe } from "@/lib/socket";
import { everyVisible } from "@/lib/visible-interval";
import { useT } from "@/lib/i18n";

function tone(n: number): string {
  return n > 0 ? "text-up" : n < 0 ? "text-down" : "text-ink-muted";
}

function strikeOfRow(rows: readonly OptionRow[], symbol: string): number | null {
  return rows.find((row) => row.symbol === symbol)?.strike ?? null;
}

/**
 * 옵션 거래 화면. PC는 왼쪽 차트·호가, 오른쪽 주문·내 포지션. 폰은 시세 → 주문 → 포지션 → 차트 → 호가 순.
 * 같은 기초자산의 다른 행사가·콜/풋은 위쪽 칩으로 바로 옮겨 간다.
 */
export default function OptionPage({ params }: { params: Promise<{ symbol: string }> }) {
  const { symbol } = use(params);
  const def = optionDef(symbol);
  const t = useT();
  const [rows, setRows] = useState<OptionRow[]>([]);
  const [last, setLast] = useState<number | null>(null);
  const [account, setAccount] = useState<FuturesAccount | null>(null);
  const [available, setAvailable] = useState<number | null>(null);
  const [priceHint, setPriceHint] = useState<{ price: number; seq: number } | null>(null);

  useEffect(() => {
    if (!def) return;
    let active = true;
    const load = () =>
      api<OptionRow[]>("/market/options", { auth: false })
        .then((data) => {
          if (active) setRows(data);
        })
        .catch(() => {});
    load();
    const stop = everyVisible(load, 10_000);
    const unsub = subscribe([`trades:${def.symbol}`], ({ data }) => {
      const price = Number((data as { price?: unknown })?.price);
      if (active && Number.isFinite(price)) setLast(price);
    });
    return () => {
      active = false;
      stop();
      unsub();
    };
  }, [def]);

  const refreshAccount = useCallback(() => {
    if (!getUser()) return;
    api<FuturesAccount>("/account/futures")
      .then(setAccount)
      .catch(() => {});
    api<{ available: number }>("/account")
      .then((a) => setAvailable(a.available))
      .catch(() => {});
  }, []);
  useEffect(() => {
    refreshAccount();
    return everyVisible(refreshAccount, 10_000);
  }, [refreshAccount]);

  if (!def) {
    return (
      <div className="mx-auto max-w-3xl py-16 text-center text-sm text-ink-muted">
        {t("없는 옵션입니다.")}{" "}
        <Link href="/market?kind=futures" className="text-sky">
          {t("증권으로 돌아가기")}
        </Link>
      </div>
    );
  }

  const row = rows.find((r) => r.symbol === def.symbol) ?? null;
  const price = last ?? row?.lastPrice ?? null;
  const position = account?.options?.find((p) => p.symbol === def.symbol) ?? null;
  // 같은 기초자산의 옵션 — 콜 먼저, 각각 행사가 순
  const siblings = ALL_OPTIONS.filter((o) => o.family.code === def.family.code).sort((a, b) =>
    a.type !== b.type
      ? a.type === "CALL"
        ? -1
        : 1
      : (strikeOfRow(rows, a.symbol) ?? a.slot) - (strikeOfRow(rows, b.symbol) ?? b.slot),
  );
  const retired = def.family.retired === true;
  const expired = row?.expired === true;
  const strikeOf = (sym: string) => rows.find((r) => r.symbol === sym)?.strike ?? null;
  const intrinsic =
    row?.strike != null && row.underlying != null
      ? Math.max(0, def.type === "CALL" ? row.underlying - row.strike : row.strike - row.underlying)
      : null;

  return (
    <div className="mx-auto max-w-6xl space-y-4 max-lg:pb-10">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Link
          href="/market?kind=futures"
          className="inline-flex shrink-0 items-center gap-1.5 text-[13px] text-ink-muted transition-colors hover:text-sky"
        >
          <span aria-hidden>←</span> {t("옵션 목록")}
        </Link>
        <nav
          aria-label={t("같은 기초자산의 다른 옵션")}
          className="chip-scroller flex min-w-0 flex-1 gap-1.5 overflow-x-auto"
        >
          {siblings.map((o) => (
            <Link
              key={o.symbol}
              href={`/options/${o.symbol}`}
              aria-current={o.symbol === def.symbol ? "page" : undefined}
              className={`num shrink-0 rounded-full px-3 py-1 text-[12px] font-medium whitespace-nowrap transition-colors ${
                o.symbol === def.symbol
                  ? "bg-sky/12 text-sky ring-1 ring-sky/30 ring-inset"
                  : "text-ink-muted ring-1 ring-hairline ring-inset hover:text-ink"
              }`}
            >
              {o.type === "CALL" ? t("콜") : t("풋")} {fmtStrike(o.symbol, strikeOf(o.symbol))}
            </Link>
          ))}
        </nav>
      </div>

      <div className="glass p-4 sm:p-5">
        <p className="text-[13px] text-ink-muted">
          {def.symbol} · {t("1일물 유럽형 옵션")}{" "}
          <span className="text-ink-faint">
            · {t("만기까지 {time}", { time: row ? timeLeft(row.expiresAt) : "—" })} (
            {t("04:10 현금 정산")})
          </span>
        </p>
        <h1
          className={`mt-1 text-xl font-semibold tracking-tight sm:text-2xl ${def.type === "CALL" ? "text-up" : "text-down"}`}
        >
          {optionLabel(def.symbol, row?.strike)}
        </h1>
        <div className="mt-2 flex flex-wrap items-end gap-x-5 gap-y-1">
          <p className="num text-2xl font-semibold tracking-tight sm:text-3xl">
            {fmtOption(def.symbol, price)}
          </p>
          <p className="num pb-1 text-sm text-ink-muted">
            {t("이론가")} {fmtOption(def.symbol, row?.theo)}
          </p>
        </div>
        <dl className="num mt-2 flex flex-wrap gap-x-5 gap-y-1 text-[13px] text-ink-muted">
          <div>
            {t("기초자산")}{" "}
            <span className="text-ink">{fmtOption(def.symbol, row?.underlying)}</span>
          </div>
          <div>
            {t("행사가")} <span className="text-ink">{fmtStrike(def.symbol, row?.strike)}</span>
          </div>
          <div title={t("지금 만기라면 받을 금액(계약당 가격 단위)")}>
            {t("내재가치")} <span className="text-ink">{fmtOption(def.symbol, intrinsic)}</span>
          </div>
        </dl>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px] lg:grid-rows-[auto_1fr]">
        <div className="max-lg:order-3 lg:col-start-1 lg:row-start-1">
          <section className="glass p-3 sm:p-4">
            <UnitCandleChart
              candlesUrl={(interval, limit) =>
                `/market/candles/${def.symbol}?interval=${interval}&limit=${limit}`
              }
              channel={`trades:${def.symbol}`}
              tickFrom={(data) => {
                const d = data as { price?: unknown; ts?: unknown };
                const value = Number(d?.price);
                const ts = Number(d?.ts);
                return Number.isFinite(value) && Number.isFinite(ts) ? { value, ts } : null;
              }}
              scale={def.priceScale}
              decimals={def.decimals}
            />
          </section>
        </div>
        <div className="space-y-4 max-lg:order-1 lg:col-start-2 lg:row-span-2 lg:row-start-1">
          {retired && (
            <p role="note" className="glass p-3 text-[13px] leading-5 text-warn">
              {expired
                ? t("만기가 지나 정산이 끝난 옵션입니다. 더는 주문할 수 없습니다.")
                : t(
                    "거래가 끝난 옵션입니다. 새로 살 수 없고, 보유분은 매도하거나 다음 04:10 만기에 현금 정산됩니다.",
                  )}
            </p>
          )}
          {!expired && (
            <OptionOrderPanel
              retired={retired}
              symbol={def.symbol}
              lastPrice={price}
              position={position}
              available={available}
              priceHint={priceHint}
              onPlaced={refreshAccount}
            />
          )}
          {position && (
            <section className="glass p-4">
              <p className="panel-title">{t("내 포지션")}</p>
              <dl className="num mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-[13px]">
                <dt className="text-ink-muted">{t("보유")}</dt>
                <dd className="text-right font-semibold">{t("{n}계약", { n: position.qty })}</dd>
                <dt className="text-ink-muted">{t("평균 매수가")}</dt>
                <dd className="text-right">
                  {fmtOption(def.symbol, Math.round(position.avgPrice))}
                </dd>
                <dt className="text-ink-muted">{t("평가금액")}</dt>
                <dd className="text-right">{won(position.value)}</dd>
                <dt className="text-ink-muted">{t("평가손익")}</dt>
                <dd className={`text-right font-semibold ${tone(position.unrealized)}`}>
                  {position.unrealized > 0 ? "+" : ""}
                  {won(position.unrealized)}
                </dd>
              </dl>
            </section>
          )}
        </div>
        <div className="max-lg:order-4 lg:col-start-1 lg:row-start-2 lg:self-start">
          <FuturesBook
            symbol={def.symbol}
            onPick={(p) => setPriceHint({ price: p, seq: Date.now() })}
          />
        </div>
      </div>

      <AssetNews
        reference={
          def.family.code === "K" ? "market" : def.family.code === "KCOM" ? "commodity" : "USDKRW"
        }
        title={
          def.family.code === "K"
            ? t("시장 뉴스")
            : def.family.code === "KCOM"
              ? t("원자재 뉴스")
              : t("관련 뉴스")
        }
      />
    </div>
  );
}
