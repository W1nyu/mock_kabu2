"use client";

import {
  HistoricalReplayEngine,
  HybridReplayEngine,
  REPLAY_SPEEDS,
  type ReplayCandleInput,
  type ReplayMode,
  type ReplaySnapshot,
  type ReplaySpeed,
} from "@mock-kabu/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReplayChart, { type ReplayChartCandle } from "@/components/ReplayChart";
import { api } from "@/lib/api";

const STARTING_CASH = 10_000_000; // USD cents = $100,000.00
const BAR_DURATION_MS = 1_000;

type Runner = HistoricalReplayEngine | HybridReplayEngine;

interface Dataset {
  id: string;
  symbol: string;
  name: string;
  exchange: string;
  currency: string;
  priceScale: number;
  defaultRange: ReplayRange;
  maxCandleCount: number;
  notice: string;
}

type ReplayRange = "1mo" | "3mo" | "6mo" | "1y" | "2y" | "3y";

const REPLAY_RANGES: readonly { value: ReplayRange; label: string }[] = [
  { value: "1mo", label: "1개월 · 30봉" },
  { value: "3mo", label: "3개월 · 90봉" },
  { value: "6mo", label: "6개월 · 180봉" },
  { value: "1y", label: "1년 · 365봉" },
  { value: "2y", label: "2년 · 730봉" },
  { value: "3y", label: "3년 · 1,095봉" },
];

interface CatalogResponse {
  datasets: Dataset[];
  priceEncoding: string;
  tradingIsolation: string;
}

interface ReplayDataResponse {
  dataset: Pick<Dataset, "id" | "symbol" | "name" | "exchange" | "currency" | "priceScale">;
  interval: "1d";
  candles: ReplayCandleInput[];
  source: {
    provider: string;
    label: string;
    sourceUrl: string | null;
    termsUrl: string | null;
    fixedAt: string;
    notice: string;
  };
  hybrid: {
    supported: true;
    defaultMaxDeviationBps: number;
    description: string;
  };
}

interface ReplayWallet {
  cash: number;
  qty: number;
  costBasis: number;
}

const initialWallet = (): ReplayWallet => ({ cash: STARTING_CASH, qty: 0, costBasis: 0 });

function pickStartIndex(length: number, seed: number): number {
  if (length <= 1) return 0;
  const history = Math.min(60, Math.max(8, Math.floor(length * 0.35)));
  const remaining = Math.min(80, Math.max(8, Math.floor(length * 0.4)));
  const min = Math.min(history, length - 1);
  const max = Math.max(min, length - remaining - 1);
  const fraction = ((seed >>> 0) % 10_000) / 10_000;
  return min + Math.floor((max - min + 1) * fraction);
}

function newScenarioSeed(): number {
  return Math.floor(Math.random() * 0x7fff_ffff) ^ Date.now();
}

function formatMoney(value: number, currency: string, scale: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(value / scale);
}

function formatDate(ts: number): string {
  return new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(new Date(ts));
}

function virtualBotState(pressure: number): string {
  if (pressure >= 0.3) return "가상 모멘텀 봇 매수 우위";
  if (pressure <= -0.3) return "가상 모멘텀 봇 매도 우위";
  return "가상 MM 봇 양방향 유동성";
}

export default function ReplayPage() {
  const [catalog, setCatalog] = useState<Dataset[]>([]);
  const [datasetId, setDatasetId] = useState("");
  const [range, setRange] = useState<ReplayRange>("6mo");
  const [data, setData] = useState<ReplayDataResponse | null>(null);
  const [mode, setMode] = useState<ReplayMode>("historical");
  const [speed, setSpeed] = useState<ReplaySpeed>(1);
  const [bandBps, setBandBps] = useState(500);
  const [scenarioSeed, setScenarioSeed] = useState(0);
  const [snapshot, setSnapshot] = useState<ReplaySnapshot | null>(null);
  const [wallet, setWallet] = useState<ReplayWallet>(initialWallet);
  const [qtyInput, setQtyInput] = useState("1");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const runnerRef = useRef<Runner | null>(null);

  useEffect(() => {
    let active = true;
    api<CatalogResponse>("/replay/datasets", { auth: false })
      .then((response) => {
        if (!active) return;
        setCatalog(response.datasets);
        const first = response.datasets[0];
        if (first) {
          setDatasetId((current) => current || first.id);
          setRange(first.defaultRange);
        }
      })
      .catch((err) => active && setError(err instanceof Error ? err.message : "리플레이 종목을 불러오지 못했습니다."))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!datasetId) return;
    let active = true;
    setLoading(true);
    setError(null);
    setData(null);
    const query = new URLSearchParams({ range });
    api<ReplayDataResponse>(`/replay/datasets/${encodeURIComponent(datasetId)}/candles?${query}`, { auth: false })
      .then((response) => {
        if (!active) return;
        if (response.candles.length === 0) throw new Error("재생할 과거 시세가 없습니다.");
        setData(response);
      })
      .catch((err) => active && setError(err instanceof Error ? err.message : "과거 시세를 불러오지 못했습니다."))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [datasetId, range]);

  useEffect(() => {
    if (!data) return;
    try {
      const startIndex = pickStartIndex(data.candles.length, scenarioSeed);
      const options = { startIndex, speed, barDurationMs: BAR_DURATION_MS };
      const next: Runner =
        mode === "historical"
          ? new HistoricalReplayEngine(data.candles, options)
          : new HybridReplayEngine(data.candles, {
              ...options,
              bandBps,
              tickSize: 1,
              seed: scenarioSeed,
            });
      runnerRef.current = next;
      setSnapshot(next.snapshot());
      setWallet(initialWallet());
      setQtyInput("1");
      setMessage(null);
    } catch (err) {
      runnerRef.current = null;
      setSnapshot(null);
      setError(err instanceof Error ? err.message : "리플레이를 초기화하지 못했습니다.");
    }
  // 새 데이터·새 시나리오·모드/밴드 변경만 새 엔진을 만든다. 속도 변경은 아래 핸들러가 상태를 보존한다.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, mode, bandBps, scenarioSeed]);

  useEffect(() => {
    if (snapshot?.status !== "playing") return;
    const timer = window.setInterval(() => {
      const runner = runnerRef.current;
      if (runner) setSnapshot(runner.advance(100));
    }, 100);
    return () => window.clearInterval(timer);
  }, [snapshot?.status]);

  const priceScale = data?.dataset.priceScale ?? 100;
  const currency = data?.dataset.currency ?? "USD";
  const currentPrice = snapshot?.current.price ?? 0;
  const chartCandles = useMemo<ReplayChartCandle[]>(() => {
    if (!snapshot) return [];
    // 지표도 공개된 봉만 계산한다. 아직 공개되지 않은 미래 OHLC는 여기로 전달하지 않는다.
    return snapshot.visibleCandles.map((candle) => ({
      time: candle.ts,
      open: candle.open / priceScale,
      high: candle.high / priceScale,
      low: candle.low / priceScale,
      close: candle.close / priceScale,
      volume: candle.volume,
    }));
  }, [priceScale, snapshot]);

  const chartCurrent = snapshot
    ? {
        time: snapshot.current.ts,
        open: snapshot.current.referencePrice / priceScale,
        high: snapshot.current.referencePrice / priceScale,
        low: snapshot.current.referencePrice / priceScale,
        close: snapshot.current.price / priceScale,
        volume: 0,
      }
    : null;
  const value = wallet.qty * currentPrice;
  const total = wallet.cash + value;
  const pnl = total - STARTING_CASH;
  const pnlRate = (pnl / STARTING_CASH) * 100;
  const avgCost = wallet.qty > 0 ? wallet.costBasis / wallet.qty : 0;

  const resetScenario = useCallback(() => {
    setScenarioSeed(newScenarioSeed());
  }, []);

  function togglePlayback() {
    const runner = runnerRef.current;
    if (!runner || !snapshot) return;
    if (snapshot.status === "finished") {
      runner.reset(0);
      setSnapshot(runner.play());
      return;
    }
    setSnapshot(snapshot.status === "playing" ? runner.pause() : runner.play());
  }

  function advanceOneBar() {
    const runner = runnerRef.current;
    if (!runner || !snapshot) return;
    runner.play();
    const next = runner.advance(BAR_DURATION_MS / snapshot.speed);
    if (next.status !== "finished") runner.pause();
    setSnapshot(runner.snapshot());
  }

  function changeSpeed(nextSpeed: ReplaySpeed) {
    setSpeed(nextSpeed);
    const runner = runnerRef.current;
    if (runner) setSnapshot(runner.setSpeed(nextSpeed));
  }

  function placeMarketOrder(side: "BUY" | "SELL") {
    const qty = Number(qtyInput);
    if (!Number.isSafeInteger(qty) || qty <= 0) {
      setMessage({ ok: false, text: "수량은 1주 이상의 정수로 입력하세요." });
      return;
    }
    if (!currentPrice || !snapshot) return;
    const cost = qty * currentPrice;
    if (side === "BUY") {
      if (wallet.cash < cost) {
        setMessage({ ok: false, text: "리플레이 가상 계좌의 주문 가능 현금이 부족합니다." });
        return;
      }
      setWallet((current) => ({
        cash: current.cash - cost,
        qty: current.qty + qty,
        costBasis: current.costBasis + cost,
      }));
      setMessage({ ok: true, text: `${qty}주를 ${formatMoney(currentPrice, currency, priceScale)}에 매수했습니다.` });
    } else {
      if (wallet.qty < qty) {
        setMessage({ ok: false, text: "보유 수량보다 많이 매도할 수 없습니다." });
        return;
      }
      setWallet((current) => {
        const costReduction = current.qty > 0 ? Math.floor((current.costBasis * qty) / current.qty) : 0;
        return {
          cash: current.cash + cost,
          qty: current.qty - qty,
          costBasis: current.costBasis - costReduction,
        };
      });
      setMessage({ ok: true, text: `${qty}주를 ${formatMoney(currentPrice, currency, priceScale)}에 매도했습니다.` });
    }
  }

  function beginDataChange() {
    // Effects run after paint. Clear the old runner in the event handler so a
    // newly selected ticker/period never briefly renders the prior bar count.
    setLoading(true);
    setError(null);
    setData(null);
    setSnapshot(null);
  }

  function selectRange(nextRange: ReplayRange) {
    beginDataChange();
    setRange(nextRange);
  }

  function selectDataset(nextId: string) {
    const next = catalog.find((dataset) => dataset.id === nextId);
    beginDataChange();
    setDatasetId(nextId);
    if (next) {
      setRange(next.defaultRange);
    }
  }

  return (
    <div className="space-y-5">
      <section className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold tracking-wide text-amber-400">FIXED REPLAY LAB</p>
          <h1 className="mt-1 text-2xl font-bold text-white">실전 리플레이</h1>
          <p className="mt-2 max-w-3xl text-sm text-neutral-400">
            종목별 고정 일봉을 한 봉씩 공개하며 별도 가상 계좌로 연습합니다. 기존 5개 모의 종목·주문·봇·잔액에는 영향을 주지 않습니다.
          </p>
        </div>
        <div className="rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2 text-right text-xs text-neutral-400">
          <p>리플레이 전용 가상 계좌</p>
          <p className="mt-1 font-semibold tabular-nums text-neutral-100">시작 {formatMoney(STARTING_CASH, currency, priceScale)}</p>
        </div>
      </section>

      <section className="rounded-lg border border-neutral-800 bg-neutral-900 p-4">
        <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Control label="실제 종목">
              <select
                value={datasetId}
                onChange={(event) => selectDataset(event.target.value)}
                className="w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-2 text-sm"
                disabled={catalog.length === 0}
              >
                {catalog.map((dataset) => (
                  <option key={dataset.id} value={dataset.id}>
                    {dataset.symbol} · {dataset.name}
                  </option>
                ))}
              </select>
            </Control>
            <Control label="기간">
              <select
                value={range}
                onChange={(event) => selectRange(event.target.value as ReplayRange)}
                className="w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-2 text-sm"
              >
                {REPLAY_RANGES.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </Control>
            <Control label="재생 방식">
              <div className="grid grid-cols-2 gap-1 rounded bg-neutral-950 p-1 text-xs">
                <ModeButton active={mode === "historical"} onClick={() => setMode("historical")}>기준 경로</ModeButton>
                <ModeButton active={mode === "hybrid"} onClick={() => setMode("hybrid")}>봇 혼합</ModeButton>
              </div>
            </Control>
          </div>
          <button
            type="button"
            onClick={resetScenario}
            disabled={!data}
            className="rounded border border-neutral-700 px-3 py-2 text-sm text-neutral-300 hover:bg-neutral-800 disabled:opacity-40"
          >
            새 시나리오
          </button>
        </div>

        {mode === "hybrid" && (
          <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-neutral-800 pt-3 text-sm">
            <span className="mr-1 text-neutral-400">봇 변동 한도</span>
            {([100, 250, 500] as const).map((bps) => (
              <button
                key={bps}
                type="button"
                onClick={() => setBandBps(bps)}
                className={`rounded px-2.5 py-1.5 tabular-nums ${bandBps === bps ? "bg-amber-400 text-neutral-950" : "bg-neutral-800 text-neutral-300 hover:bg-neutral-700"}`}
              >
                ±{(bps / 100).toFixed(bps % 100 ? 1 : 0)}%
              </button>
            ))}
            <span className="ml-2 text-xs text-neutral-500">실제 가격 경로의 이 범위 밖으로는 절대 움직이지 않습니다.</span>
          </div>
        )}
      </section>

      {error && <p className="rounded border border-blue-500/40 bg-blue-500/10 px-3 py-2 text-sm text-blue-300">{error}</p>}
      {loading && <p className="rounded border border-neutral-800 bg-neutral-900 px-3 py-8 text-center text-sm text-neutral-500">과거 시세를 불러오는 중…</p>}

      {data && snapshot && !loading && (
        <>
          <section className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
            <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-3">
              <div className="mb-3 flex flex-wrap items-start justify-between gap-3 px-1">
                <div>
                  <h2 className="font-semibold text-white">{data.dataset.symbol} · {data.dataset.name}</h2>
                  <p className="mt-1 text-xs text-neutral-500">
                    {formatDate(snapshot.current.ts)} · 공개 {snapshot.completedBars}/{snapshot.totalBars} 일봉
                  </p>
                </div>
                <div className="text-right tabular-nums">
                  <p className="text-xl font-bold text-amber-300">{formatMoney(snapshot.current.price, currency, priceScale)}</p>
                  {mode === "hybrid" ? (
                    <>
                      <p className={snapshot.current.perturbationBps >= 0 ? "text-xs text-red-400" : "text-xs text-blue-400"}>
                        가상 봇 압력 {snapshot.current.perturbationBps >= 0 ? "+" : ""}{(snapshot.current.perturbationBps / 100).toFixed(2)}%
                      </p>
                      <p className="mt-0.5 text-[11px] text-neutral-500">
                        기준 {formatMoney(snapshot.current.referencePrice, currency, priceScale)} · 허용 {formatMoney(snapshot.current.lowerBound, currency, priceScale)}–{formatMoney(snapshot.current.upperBound, currency, priceScale)}
                      </p>
                      <p className="mt-0.5 text-[11px] text-neutral-500">{virtualBotState(snapshot.current.syntheticPressure)}</p>
                    </>
                  ) : <p className="text-xs text-neutral-500">고정 기준 경로 그대로</p>}
                </div>
              </div>
              <ReplayChart candles={chartCandles} currentCandle={chartCurrent} currentPrice={snapshot.current.price / priceScale} />
              <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-neutral-800 pt-3">
                <button type="button" onClick={togglePlayback} className="rounded bg-amber-400 px-3 py-1.5 text-sm font-semibold text-neutral-950 hover:bg-amber-300">
                  {snapshot.status === "playing" ? "일시정지" : snapshot.status === "finished" ? "처음부터 재생" : "재생"}
                </button>
                <button type="button" onClick={advanceOneBar} className="rounded bg-neutral-800 px-3 py-1.5 text-sm text-neutral-200 hover:bg-neutral-700">한 봉 진행</button>
                <div className="ml-1 flex rounded bg-neutral-950 p-1">
                  {REPLAY_SPEEDS.map((candidate) => (
                    <button
                      key={candidate}
                      type="button"
                      onClick={() => changeSpeed(candidate)}
                      className={`rounded px-2 py-1 text-xs tabular-nums ${speed === candidate ? "bg-neutral-700 text-white" : "text-neutral-500 hover:text-neutral-200"}`}
                    >
                      x{candidate}
                    </button>
                  ))}
                </div>
                <span className="ml-auto text-xs text-neutral-500">1x 기준 1초마다 다음 일봉</span>
              </div>
            </div>

            <aside className="space-y-4">
              <section className="rounded-lg border border-neutral-800 bg-neutral-900 p-4">
                <h2 className="text-sm font-semibold text-neutral-200">리플레이 가상 계좌</h2>
                <dl className="mt-3 space-y-2 text-sm tabular-nums">
                  <WalletRow label="총 자산" value={formatMoney(total, currency, priceScale)} strong />
                  <WalletRow label="현금" value={formatMoney(wallet.cash, currency, priceScale)} />
                  <WalletRow label="보유" value={`${wallet.qty.toLocaleString("ko-KR")}주`} />
                  <WalletRow label="평단가" value={wallet.qty ? formatMoney(avgCost, currency, priceScale) : "—"} />
                  <WalletRow label="평가손익" value={`${pnl >= 0 ? "+" : ""}${formatMoney(pnl, currency, priceScale)} (${pnl >= 0 ? "+" : ""}${pnlRate.toFixed(2)}%)`} tone={pnl >= 0 ? "up" : "down"} />
                </dl>
                <button type="button" onClick={() => { setWallet(initialWallet()); setMessage(null); }} className="mt-3 w-full rounded border border-neutral-700 py-1.5 text-xs text-neutral-400 hover:bg-neutral-800">
                  가상 계좌 초기화
                </button>
              </section>

              <section className="rounded-lg border border-neutral-800 bg-neutral-900 p-4">
                <h2 className="text-sm font-semibold text-neutral-200">현재가 모의 주문</h2>
                <p className="mt-1 text-xs text-neutral-500">실제 거래소 주문과 완전히 분리된 시장가 체결입니다.</p>
                <label className="mt-3 block text-xs text-neutral-400">
                  수량
                  <input
                    value={qtyInput}
                    onChange={(event) => setQtyInput(event.target.value.replace(/[^0-9]/g, ""))}
                    inputMode="numeric"
                    className="mt-1 w-full rounded border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm tabular-nums text-white"
                  />
                </label>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <button type="button" onClick={() => placeMarketOrder("BUY")} className="rounded bg-red-500/85 py-2 text-sm font-semibold text-white hover:bg-red-400">매수</button>
                  <button type="button" onClick={() => placeMarketOrder("SELL")} className="rounded bg-blue-500/85 py-2 text-sm font-semibold text-white hover:bg-blue-400">매도</button>
                </div>
                {message && <p className={`mt-3 text-xs ${message.ok ? "text-emerald-400" : "text-blue-400"}`}>{message.text}</p>}
              </section>
            </aside>
          </section>

          <section className="rounded-lg border border-neutral-800 bg-neutral-900 p-4 text-xs text-neutral-400">
            <p>데이터: <span className="text-neutral-300">{data.source.label}</span>{" · "}{data.candles.length.toLocaleString("ko-KR")}개 고정 일봉{" · "}기준 {new Date(data.source.fixedAt).toLocaleDateString("ko-KR")}</p>
            <p className="mt-1">
              {data.source.notice}
              {data.source.termsUrl && <> <a href={data.source.termsUrl} target="_blank" rel="noreferrer" className="text-amber-400 hover:underline">약관</a></>}
            </p>
            <p className="mt-1 text-neutral-500">{data.hybrid.description} 투자 조언이나 실제 주문 기능이 아닙니다.</p>
          </section>
        </>
      )}
    </div>
  );
}

function Control({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-xs text-neutral-400">
      <span className="mb-1 block">{label}</span>
      {children}
    </label>
  );
}

function ModeButton({ active, children, onClick }: { active: boolean; children: React.ReactNode; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className={`rounded px-2 py-2 ${active ? "bg-amber-400 font-semibold text-neutral-950" : "text-neutral-400 hover:text-neutral-100"}`}>
      {children}
    </button>
  );
}

function WalletRow({ label, value, tone, strong = false }: { label: string; value: string; tone?: "up" | "down"; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-neutral-500">{label}</dt>
      <dd className={`${strong ? "font-semibold text-white" : "text-neutral-200"} ${tone === "up" ? "text-red-400" : tone === "down" ? "text-blue-400" : ""}`}>{value}</dd>
    </div>
  );
}
