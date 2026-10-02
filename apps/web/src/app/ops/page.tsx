"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { SYMBOLS } from "@mock-kabu/shared";
import { api, getToken, getUser } from "@/lib/api";
import { formatKstHm, formatKstMonthDay, MARKET_TIME_ZONE_LABEL } from "@/lib/time";
import { MarketCyclePanel } from "./MarketCyclePanel";

type Direction = "UP" | "DOWN";

interface Scenario {
  id: string;
  symbols: string[];
  direction: Direction;
  intensity: number;
  startsAt: string;
  endsAt: string;
  createdBy: string;
  canceledAt: string | null;
  createdAt: string;
}

const INTENSITY_LABEL: Record<number, string> = { 1: "약", 2: "중", 3: "강" };
const INTENSITY_HINT: Record<number, string> = {
  1: "해당 방향 뉴스 약 6:4, 추가 뉴스 15~35분마다",
  2: "해당 방향 뉴스 약 7:3, 추가 뉴스 9~20분마다",
  3: "해당 방향 뉴스 약 8:2, 추가 뉴스 6~14분마다",
};
const DURATION_OPTIONS = [5, 10, 15, 30, 60, 120, 180, 360, 720, 1440];
const KST_OFFSET_MS = 9 * 60 * 60_000;

/** `datetime-local` value (read as KST, whatever the browser's zone) → epoch ms. */
function kstInputToMs(value: string): number {
  return Date.parse(`${value}:00+09:00`);
}

/** epoch ms → `datetime-local` value in KST. */
function msToKstInput(ms: number): string {
  return new Date(ms + KST_OFFSET_MS).toISOString().slice(0, 16);
}

function nextFiveMinutes(now = Date.now()): number {
  const step = 5 * 60_000;
  return Math.ceil((now + 60_000) / step) * step;
}

function durationLabel(minutes: number): string {
  if (minutes < 60) return `${minutes}분`;
  return minutes % 60 === 0 ? `${minutes / 60}시간` : `${Math.floor(minutes / 60)}시간 ${minutes % 60}분`;
}

function status(scenario: Scenario, now: number): { label: string; className: string } {
  if (scenario.canceledAt) return { label: "취소", className: "chip" };
  if (now >= Date.parse(scenario.endsAt)) return { label: "종료", className: "chip" };
  if (now >= Date.parse(scenario.startsAt)) return { label: "진행 중", className: "chip chip-live" };
  return { label: "예정", className: "chip" };
}

function when(iso: string): string {
  const ms = Date.parse(iso);
  return `${formatKstMonthDay(ms)} ${formatKstHm(ms)}`;
}

/**
 * 관리자 전용 시장 시나리오. 내비게이션 어디에도 연결하지 않는다 — 주소를 아는
 * 관리자만 들어오며, 관리자가 아니면 API가 404를 주고 이 화면은 홈으로 보낸다.
 */
export default function OpsPage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [symbols, setSymbols] = useState<string[]>([]);
  const [direction, setDirection] = useState<Direction>("DOWN");
  const [intensity, setIntensity] = useState(2);
  const [startsAt, setStartsAt] = useState(() => msToKstInput(nextFiveMinutes()));
  const [duration, setDuration] = useState(180);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const refresh = useCallback(() => {
    api<Scenario[]>("/admin/market-scenarios").then(setScenarios).catch(() => {});
  }, []);

  useEffect(() => {
    if (!getToken() || getUser()?.isAdmin !== true) {
      router.replace("/");
      return;
    }
    setReady(true);
    refresh();
    const timer = window.setInterval(() => {
      setNow(Date.now());
      refresh();
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [router, refresh]);

  function toggleSymbol(symbol: string) {
    setSymbols((current) =>
      current.includes(symbol) ? current.filter((s) => s !== symbol) : [...current, symbol],
    );
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const start = kstInputToMs(startsAt);
    if (!Number.isFinite(start)) {
      setMessage({ ok: false, text: "시작 시각을 확인하세요" });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const created = await api<Scenario & { requestedStartsAt: string | null }>("/admin/market-scenarios", {
        method: "POST",
        body: {
          symbols,
          direction,
          intensity,
          startsAt: new Date(start).toISOString(),
          endsAt: new Date(start + duration * 60_000).toISOString(),
        },
      });
      setMessage({
        ok: true,
        text: created.requestedStartsAt
          ? `같은 종목의 앞선 시나리오와 겹쳐 ${when(created.startsAt)} ~ ${when(created.endsAt)}로 미뤄 등록했습니다`
          : "시나리오를 등록했습니다",
      });
      setSymbols([]);
      setNow(Date.now());
      refresh();
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : "등록하지 못했습니다" });
    } finally {
      setBusy(false);
    }
  }

  async function cancel(id: string) {
    try {
      await api(`/admin/market-scenarios/${id}/cancel`, { method: "POST" });
      setNow(Date.now());
      refresh();
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : "취소하지 못했습니다" });
    }
  }

  async function remove(id: string) {
    try {
      await api(`/admin/market-scenarios/${id}`, { method: "DELETE" });
      setScenarios((current) => current.filter((scenario) => scenario.id !== id));
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : "삭제하지 못했습니다" });
    }
  }

  if (!ready) return null;

  const start = kstInputToMs(startsAt);
  const end = Number.isFinite(start) ? start + duration * 60_000 : NaN;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
      <section className="space-y-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">시장 시나리오</h1>
          <p className="mt-1 text-sm text-ink-muted">
            평소에는 봇이 자동 장세(상승장·하락장·횡보장)를 스스로 돌립니다. 시나리오는 그 위에 더해 정한 시간 동안 고른 종목에 호재 또는 악재가 더 자주, 더 세게 나오고 봇 주문이 그쪽으로 기웁니다.
            가격을 직접 움직이지는 않으며, 시작·종료 10분 동안 서서히 켜지고 꺼집니다. 사용자에게는 보이지 않습니다.
            같은 종목에 이미 잡힌 시나리오와 시간이 겹치면, 새 시나리오는 그 시나리오가 끝난 뒤로 미뤄 등록됩니다.
          </p>
        </div>

        <form onSubmit={submit} className="glass space-y-4 p-5">
          <div>
            <p className="label">종목 (여러 개 선택 가능)</p>
            <div className="flex flex-wrap gap-2">
              {SYMBOLS.map((symbol) => {
                const selected = symbols.includes(symbol.symbol);
                return (
                  <button
                    key={symbol.symbol}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => toggleSymbol(symbol.symbol)}
                    className={`btn btn-sm ${selected ? "btn-primary" : "btn-ghost"}`}
                  >
                    {symbol.symbol} <span className="font-normal opacity-75">{symbol.name}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <p className="label">방향</p>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                aria-pressed={direction === "UP"}
                onClick={() => setDirection("UP")}
                className={`btn ${direction === "UP" ? "btn-buy" : "btn-ghost"}`}
              >
                상승 압력 (호재)
              </button>
              <button
                type="button"
                aria-pressed={direction === "DOWN"}
                onClick={() => setDirection("DOWN")}
                className={`btn ${direction === "DOWN" ? "btn-sell" : "btn-ghost"}`}
              >
                하방 압력 (악재)
              </button>
            </div>
          </div>

          <div>
            <p className="label">강도</p>
            <div className="grid grid-cols-3 gap-2">
              {[1, 2, 3].map((level) => (
                <button
                  key={level}
                  type="button"
                  aria-pressed={intensity === level}
                  onClick={() => setIntensity(level)}
                  className={`btn ${intensity === level ? "btn-primary" : "btn-ghost"}`}
                >
                  {INTENSITY_LABEL[level]}
                </button>
              ))}
            </div>
            <p className="mt-1 text-xs text-ink-muted">{INTENSITY_HINT[intensity]}</p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label" htmlFor="scenario-start">
                시작 ({MARKET_TIME_ZONE_LABEL})
              </label>
              <input
                id="scenario-start"
                type="datetime-local"
                className="field num"
                value={startsAt}
                onChange={(event) => setStartsAt(event.target.value)}
              />
            </div>
            <div>
              <label className="label" htmlFor="scenario-duration">
                기간
              </label>
              <select
                id="scenario-duration"
                className="field"
                value={duration}
                onChange={(event) => setDuration(Number(event.target.value))}
              >
                {DURATION_OPTIONS.map((minutes) => (
                  <option key={minutes} value={minutes}>
                    {durationLabel(minutes)}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {Number.isFinite(end) && (
            <p className="num text-xs text-ink-muted">
              {formatKstMonthDay(start)} {formatKstHm(start)} ~ {formatKstMonthDay(end)} {formatKstHm(end)}{" "}
              {MARKET_TIME_ZONE_LABEL}
            </p>
          )}

          {message && (
            <p
              className={`rounded-control border px-3 py-2 text-sm ${
                message.ok ? "border-ok/30 bg-ok/8 text-ok" : "border-up/30 bg-up/8 text-up"
              }`}
            >
              {message.text}
            </p>
          )}

          <button disabled={busy || symbols.length === 0} className="btn btn-primary btn-block">
            {busy ? "등록 중…" : "시나리오 등록"}
          </button>
        </form>
      </section>

      <section className="space-y-4">
        <MarketCyclePanel />
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">등록된 시나리오</h2>
          <p className="mt-1 text-sm text-ink-muted">최근 50건. 봇은 30초 안에 변경을 반영합니다.</p>
        </div>
        <div className="glass overflow-hidden">
          <div className="overflow-x-auto">
            <table className="tbl tbl-hover">
              <thead>
                <tr>
                  <th>상태</th>
                  <th>종목</th>
                  <th>방향·강도</th>
                  <th>기간 ({MARKET_TIME_ZONE_LABEL})</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {scenarios.map((scenario) => {
                  const state = status(scenario, now);
                  const cancellable = !scenario.canceledAt && now < Date.parse(scenario.endsAt);
                  return (
                    <tr key={scenario.id}>
                      <td>
                        <span className={state.className}>{state.label}</span>
                      </td>
                      <td className="font-medium">{scenario.symbols.join(", ")}</td>
                      <td>
                        <span className={scenario.direction === "UP" ? "chip chip-up" : "chip chip-down"}>
                          {scenario.direction === "UP" ? "상승" : "하방"} · {INTENSITY_LABEL[scenario.intensity]}
                        </span>
                      </td>
                      <td className="num whitespace-nowrap text-ink-muted">
                        {when(scenario.startsAt)} ~ {when(scenario.endsAt)}
                      </td>
                      <td className="text-right">
                        {cancellable ? (
                          <button type="button" className="btn btn-ghost btn-sm" onClick={() => cancel(scenario.id)}>
                            {now >= Date.parse(scenario.startsAt) ? "중단" : "취소"}
                          </button>
                        ) : (
                          <button type="button" className="btn btn-ghost btn-sm" onClick={() => remove(scenario.id)}>
                            삭제
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {scenarios.length === 0 && (
                  <tr>
                    <td colSpan={5} className="py-14 text-center text-sm text-ink-faint">
                      등록된 시나리오가 없습니다
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
