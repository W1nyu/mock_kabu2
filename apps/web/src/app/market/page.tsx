"use client";

import { industryById, industryOf } from "@mock-kabu/shared";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import ChipTabs from "@/components/ChipTabs";
import FuturesList from "@/components/FuturesList";
import OptionChain from "@/components/OptionChain";
import ReferenceCards from "@/components/ReferenceCards";
import Sparkline from "@/components/Sparkline";
import { api, fmt, won } from "@/lib/api";
import { indexSessionBase, type IndexPoint } from "@/lib/index-session";
import { cleanSparks } from "@/lib/sparks";
import { ALL_INDUSTRIES, INDUSTRY_STORAGE_KEY, industryChipItems } from "@/lib/industry-chips";
import { liveIndexLevel, type IndexMeta } from "@/lib/index-meta";
import { subscribe } from "@/lib/socket";
import { kstSessionStartMs, onKstSessionOpen } from "@/lib/time";
import { readQueryParam, writeQueryParams } from "@/lib/url-query";
import { everyVisible } from "@/lib/visible-interval";
import { useNames, useT } from "@/lib/i18n";

/**
 * 증권 탭 — 폰 하단 탭의 두 번째 칸. 지수 요약 카드(누르면 `/market-index`)와 전 종목 목록을
 * 한 화면에 모아, 폰에서 대시보드를 길게 내리지 않고 종목을 고르게 한다. 데스크톱에서도 열린다.
 */

interface OverviewRow {
  symbol: string;
  name: string;
  lastPrice: number;
  initialPrice: number;
  referencePrice: number;
  sessionStart: number;
  turnover: number | string | null;
}
interface CandleDto {
  ts: string;
  close: number;
}

type SortKey = "name" | "change" | "turnover";
const SORTS: { id: SortKey; label: string }[] = [
  { id: "change", label: "등락률순" },
  { id: "turnover", label: "거래대금순" },
  { id: "name", label: "이름순" },
];
const SORT_STORAGE_KEY = "market:symbol-sort";
const KIND_STORAGE_KEY = "market:kind";
type MarketKind = "stock" | "futures";
const KINDS: { id: MarketKind; label: string }[] = [
  { id: "stock", label: "현물" },
  { id: "futures", label: "선물·옵션" },
];
const indexFormatter = new Intl.NumberFormat("ko-KR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function toneClass(delta: number): string {
  return delta > 0 ? "text-up" : delta < 0 ? "text-down" : "text-ink-muted";
}
function sparkTone(values: number[]): "up" | "down" | "flat" {
  if (values.length < 2) return "flat";
  const first = values[0];
  const last = values[values.length - 1];
  return last > first ? "up" : last < first ? "down" : "flat";
}

export default function MarketPage() {
  const tr = useT();
  const names = useNames();
  const [rows, setRows] = useState<OverviewRow[]>([]);
  const [live, setLive] = useState<Record<string, number>>({});
  const [indexSeries, setIndexSeries] = useState<IndexPoint[] | null>(null);
  const [indexMeta, setIndexMeta] = useState<IndexMeta | null>(null);
  const [sparks, setSparks] = useState<Record<string, number[]>>({});
  const [sort, setSort] = useState<SortKey>("change");
  const [industry, setIndustry] = useState<string>(ALL_INDUSTRIES);
  const [kind, setKind] = useState<MarketKind>("stock");

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(SORT_STORAGE_KEY);
      if (saved === "name" || saved === "change" || saved === "turnover") setSort(saved);
    } catch {
      // ignore
    }
    // 주소의 ?industry=가 우선, 없으면 마지막으로 고른 산업군.
    let initial = readQueryParam("industry");
    if (!initial) {
      try {
        initial = window.localStorage.getItem(INDUSTRY_STORAGE_KEY);
      } catch {
        // ignore
      }
    }
    if (initial && industryById(initial)) setIndustry(initial);
    // ?kind=futures(선물 알림·링크) 우선, 없으면 마지막으로 본 탭.
    let savedKind = readQueryParam("kind");
    if (!savedKind) {
      try {
        savedKind = window.localStorage.getItem(KIND_STORAGE_KEY);
      } catch {
        // ignore
      }
    }
    if (savedKind === "futures" || savedKind === "stock") setKind(savedKind);
  }, []);

  function chooseKind(next: MarketKind) {
    setKind(next);
    writeQueryParams({ kind: next === "stock" ? null : next });
    try {
      window.localStorage.setItem(KIND_STORAGE_KEY, next);
    } catch {
      // ignore
    }
  }

  function chooseIndustry(next: string) {
    setIndustry(next);
    writeQueryParams({ industry: next === ALL_INDUSTRIES ? null : next });
    try {
      window.localStorage.setItem(INDUSTRY_STORAGE_KEY, next);
    } catch {
      // ignore
    }
  }

  function chooseSort(next: SortKey) {
    setSort(next);
    try {
      window.localStorage.setItem(SORT_STORAGE_KEY, next);
    } catch {
      // ignore
    }
  }

  const load = useCallback(() => {
    api<OverviewRow[]>("/market/overview", { auth: false })
      .then((data) => {
        if (data.every((row) => row.sessionStart >= kstSessionStartMs())) setRows(data);
      })
      .catch(() => {});
    api<IndexPoint[]>("/market/index?range=1d", { auth: false })
      .then(setIndexSeries)
      .catch(() => {});
    api<IndexMeta>("/market/index/meta", { auth: false })
      .then(setIndexMeta)
      .catch(() => {});
  }, []);

  useEffect(() => {
    load();
    const t = everyVisible(load, 15_000);
    const stopSessionRefresh = onKstSessionOpen(load);
    return () => {
      t();
      stopSessionRefresh();
    };
  }, [load]);

  const symbolKey = rows.map((r) => r.symbol).join(",");

  useEffect(() => {
    if (!symbolKey) return;
    return subscribe(
      symbolKey.split(",").map((symbol) => `trades:${symbol}`),
      ({ channel, data }) => {
        const price = Number(data?.price);
        if (!Number.isFinite(price)) return;
        const symbol = channel.slice("trades:".length);
        setLive((prev) => (prev[symbol] === price ? prev : { ...prev, [symbol]: price }));
      },
    );
  }, [symbolKey]);

  // 종목별 미니 추세선: 최근 6시간 5분봉. 5분마다만 다시 읽는다.
  useEffect(() => {
    if (!symbolKey) return;
    let active = true;
    // 전 종목을 한 요청으로 받는다(서버가 1분 공유 캐시).
    const loadSparks = () => {
      api<Record<string, number[]>>("/market/sparks", { auth: false })
        .then((data) => {
          if (active) setSparks(cleanSparks(data));
        })
        .catch(() => {});
    };
    loadSparks();
    const t = everyVisible(loadSparks, 5 * 60 * 1000);
    return () => {
      active = false;
      t();
    };
  }, [symbolKey]);

  // 현재 지수 = Σ(현재가 × 발행주식수) ÷ 제수 — MarketIndexPanel·서버와 같은 시가총액 가중 식.
  const indexNow = useMemo(() => {
    if (!indexMeta || rows.length === 0) return null;
    const bySymbol = new Map(rows.map((r) => [r.symbol, r]));
    return liveIndexLevel(indexMeta, (symbol) => live[symbol] ?? bySymbol.get(symbol)?.lastPrice);
  }, [indexMeta, rows, live]);
  const indexBase = indexSeries ? indexSessionBase(indexSeries, Date.now()) : null;
  const indexDelta = indexNow != null && indexBase != null ? indexNow - indexBase : null;
  const indexRate = indexDelta != null && indexBase ? (indexDelta / indexBase) * 100 : null;
  const indexSpark = useMemo(() => {
    const start = kstSessionStartMs();
    const today = (indexSeries ?? []).filter((p) => p.ts >= start).map((p) => p.value);
    const values = today.length >= 2 ? today : (indexSeries ?? []).map((p) => p.value);
    return indexNow != null && values.length > 0 ? [...values, indexNow] : values;
  }, [indexSeries, indexNow]);

  const list = useMemo(() => {
    const withLive = rows.map((r) => {
      const lastPrice = live[r.symbol] ?? r.lastPrice;
      const change = r.referencePrice > 0 ? ((lastPrice - r.referencePrice) / r.referencePrice) * 100 : 0;
      const turnover = Number(r.turnover ?? 0);
      return { ...r, lastPrice, change, turnover: Number.isFinite(turnover) ? turnover : 0 };
    });
    return withLive.sort((a, b) =>
      sort === "name"
        ? a.name.localeCompare(b.name, "ko")
        : sort === "change"
          ? b.change - a.change
          : b.turnover - a.turnover,
    );
  }, [rows, live, sort]);

  // 언어가 바뀌면 칩 이름도 다시 만든다(tr이 언어마다 새로 만들어진다).
  const industryItems = useMemo(() => industryChipItems(new Map(list.map((row) => [row.symbol, row.change]))), [list, tr]);

  const selectedIndustry = industryById(industry);
  const shown = selectedIndustry ? list.filter((row) => selectedIndustry.symbols.includes(row.symbol)) : list;

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">{tr("증권")}</h1>

      {/* ── 지수 요약 ─────────────────────────────────────────── */}
      <Link
        href="/market-index"
        className="glass flex items-center gap-4 p-4 transition-colors active:bg-surface-3/40 sm:p-5"
      >
        <div className="min-w-0 flex-1">
          <p className="text-[13px] text-ink-muted">{tr("KABU 지수")}</p>
          <p className="num mt-1 text-2xl font-semibold tracking-tight">
            {indexNow != null ? indexFormatter.format(indexNow) : "—"}
          </p>
          <p
            className={`num mt-0.5 text-[13px] font-medium ${indexDelta != null ? toneClass(indexDelta) : "text-ink-faint"}`}
          >
            {indexDelta != null && indexRate != null
              ? `${indexDelta > 0 ? "+" : ""}${indexDelta.toFixed(2)} (${indexRate > 0 ? "+" : ""}${indexRate.toFixed(2)}%) ${tr("오늘")}`
              : "—"}
          </p>
        </div>
        <Sparkline values={indexSpark} tone={sparkTone(indexSpark)} width={110} height={44} />
        <span aria-hidden className="text-ink-faint">
          ›
        </span>
      </Link>

      {/* ── 환율·원자재 요약 (누르면 각 화면) ─────────────────────── */}
      <ReferenceCards />

      {/* ── 현물 | 선물·옵션 전환 ─────────────────────────────── */}
      <div className="grid grid-cols-2 gap-1 rounded-xl bg-surface-2/60 p-1" role="tablist" aria-label={tr("시장 구분")}>
        {KINDS.map((k) => (
          <button
            key={k.id}
            type="button"
            role="tab"
            aria-selected={kind === k.id}
            onClick={() => chooseKind(k.id)}
            className={`min-h-10 rounded-lg text-sm font-semibold transition-colors ${
              kind === k.id ? "bg-surface-3 text-ink shadow-sm" : "text-ink-muted"
            }`}
          >
            {tr(k.label)}
          </button>
        ))}
      </div>

      {kind === "stock" && (
        <>
          {/* ── 산업군 태그 ───────────────────────────────────────── */}
          <ChipTabs label={tr("산업군")} items={industryItems} value={industry} onChange={chooseIndustry} />

          {/* ── 종목 목록 ─────────────────────────────────────────── */}
          <section className="glass overflow-hidden">
            <div className="panel-head">
              <span className="panel-title">
                {selectedIndustry ? names.industry(selectedIndustry.id, selectedIndustry.label) : tr("전체 종목")}
                <span className="num ml-1.5 font-medium text-ink-faint">{shown.length}</span>
              </span>
              <div className="flex gap-1" role="group" aria-label={tr("정렬")}>
                {SORTS.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => chooseSort(s.id)}
                    aria-pressed={sort === s.id}
                    className={`rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors ${
                      sort === s.id ? "bg-sky/12 text-sky ring-1 ring-inset ring-sky/30" : "text-ink-muted"
                    }`}
                  >
                    {tr(s.label)}
                  </button>
                ))}
              </div>
            </div>
            <ul className="divide-y divide-hairline-soft">
              {shown.map((s) => {
                const spark = sparks[s.symbol];
                const series = spark && spark.length > 0 ? [...spark.slice(0, -1), s.lastPrice] : [];
                return (
                  <li key={s.symbol}>
                    <Link
                      href={`/symbol/${s.symbol}`}
                      className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-surface-3/30 active:bg-surface-3/45"
                    >
                      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full border border-hairline-soft bg-surface-2/70 text-[12px] font-semibold text-ink-muted">
                        {names.symbol(s.symbol, s.name).slice(0, 2)}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-semibold">{names.symbol(s.symbol, s.name)}</span>
                        <span className="num block truncate text-xs text-ink-faint">
                          {s.symbol}
                          {!selectedIndustry && industryOf(s.symbol) && (
                            <span className="hidden sm:inline"> · {names.industry(industryOf(s.symbol)!.id, industryOf(s.symbol)!.label)}</span>
                          )}
                          {/* 폰은 폭이 좁아 거래대금을 빼고 종목 코드만 둔다. */}
                          <span className="hidden sm:inline">
                            {" "}
                            · {tr("{n}만 원", { n: fmt.format(Math.round(s.turnover / 10_000)) })}
                          </span>
                        </span>
                      </span>
                      <span className="hidden min-[380px]:block">
                        <Sparkline values={series} tone={sparkTone(series)} width={64} height={28} />
                      </span>
                      <span className="w-[5.5rem] shrink-0 text-right">
                        <span className="num block font-semibold">{won(s.lastPrice)}</span>
                        <span className={`num block text-xs font-medium ${toneClass(s.change)}`}>
                          {s.change > 0 ? "+" : ""}
                          {s.change.toFixed(2)}%
                        </span>
                      </span>
                    </Link>
                  </li>
                );
              })}
              {list.length === 0 && <li className="py-10 text-center text-sm text-ink-faint">{tr("종목을 불러오는 중…")}</li>}
            </ul>
          </section>
        </>
      )}

      {kind === "futures" && (
        <>
          {/* ── 선물 (1일물) ─────────────────────────────────────────── */}
          <section className="glass overflow-hidden">
            <div className="panel-head">
              <span className="panel-title">{tr("선물")}</span>
              <span className="text-[11px] text-ink-faint">{tr("1일물 · 매일 04:10 현금 정산")}</span>
            </div>
            <FuturesList />
          </section>

          {/* ── 옵션 (1일물, 주가지수·원/달러) ───────────────────────── */}
          <section className="glass overflow-hidden">
            <div className="panel-head">
              <span className="panel-title">{tr("옵션")}</span>
              <span className="text-[11px] text-ink-faint">{tr("1일물 · 매일 04:10 만기 정산")}</span>
            </div>
            <OptionChain />
          </section>

        </>
      )}
    </div>
  );
}
