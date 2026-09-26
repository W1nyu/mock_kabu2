"use client";

import { OPTION_FAMILIES } from "@mock-kabu/shared";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { fmtOption, fmtStrike, timeLeft, type OptionRow } from "@/lib/options";
import { subscribe } from "@/lib/socket";
import { everyVisible } from "@/lib/visible-interval";
import { useNames, useT } from "@/lib/i18n";

/**
 * 옵션 체인 — 기초자산(주가지수·원/달러)마다 행사가 5줄, 왼쪽 콜·오른쪽 풋의 최근가(이론가).
 * 칸을 누르면 그 옵션 거래 화면으로. 이론가는 10초마다, 체결가는 소켓으로 갱신한다.
 */
export default function OptionChain() {
  const t = useT();
  const names = useNames();
  const [rows, setRows] = useState<OptionRow[]>([]);
  const [live, setLive] = useState<Record<string, number>>({});
  const [family, setFamily] = useState<string>(OPTION_FAMILIES[0].code);

  useEffect(() => {
    let active = true;
    const load = () =>
      api<OptionRow[]>("/market/options", { auth: false })
        .then((data) => {
          if (active) setRows(data);
        })
        .catch(() => {});
    load();
    const stop = everyVisible(load, 10_000);
    return () => {
      active = false;
      stop();
    };
  }, []);

  const symbols = rows.map((row) => row.symbol).join(",");
  useEffect(() => {
    if (!symbols) return;
    return subscribe(
      symbols.split(",").map((symbol) => `trades:${symbol}`),
      ({ channel, data }) => {
        const price = Number((data as { price?: unknown })?.price);
        if (!Number.isFinite(price)) return;
        const symbol = channel.slice("trades:".length);
        setLive((prev) => (prev[symbol] === price ? prev : { ...prev, [symbol]: price }));
      },
    );
  }, [symbols]);

  const familyRows = useMemo(() => rows.filter((row) => row.family === family), [rows, family]);
  // 행사가별 한 줄(높은 행사가가 위). 종목 번호가 아니라 행사가로 묶는다 — 장중에 행사가 개수를 늘린 날은
  // 번호와 행사가 순서가 다를 수 있다.
  const strikes = useMemo(() => {
    const byStrike = new Map<number, { strike: number | null; call?: OptionRow; put?: OptionRow }>();
    for (const row of familyRows) {
      const key = row.strike ?? -row.slot;
      const entry = byStrike.get(key) ?? { strike: row.strike };
      if (row.type === "CALL") entry.call = row;
      else entry.put = row;
      byStrike.set(key, entry);
    }
    return [...byStrike.entries()].sort(([a], [b]) => b - a).map(([key, entry]) => ({ key, ...entry }));
  }, [familyRows]);
  const head = familyRows[0];
  // 등가격 = 기초자산에 가장 가까운 행사가
  const atmStrike = useMemo(() => {
    const u = head?.underlying;
    if (u == null) return null;
    let best: number | null = null;
    for (const s of strikes) if (s.strike != null && (best == null || Math.abs(s.strike - u) < Math.abs(best - u))) best = s.strike;
    return best;
  }, [strikes, head]);

  const cell = (row: OptionRow | undefined, align: "left" | "right") => {
    if (!row) return <td />;
    const price = live[row.symbol] ?? row.lastPrice;
    return (
      <td className={align === "left" ? "text-left" : "text-right"}>
        <Link
          href={`/options/${row.symbol}`}
          className={`block rounded-lg px-2 py-1.5 transition-colors hover:bg-surface-3/30 active:bg-surface-3/45 ${
            row.type === "CALL" ? "hover:text-up" : "hover:text-down"
          }`}
        >
          <span className="num block font-semibold">{fmtOption(row.symbol, price)}</span>
          <span className="num block text-[11px] text-ink-faint">{t("이론")} {fmtOption(row.symbol, row.theo)}</span>
        </Link>
      </td>
    );
  };

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-3">
        <div className="well flex gap-0.5 p-0.5" role="group" aria-label={t("기초자산")}>
          {OPTION_FAMILIES.map((f) => (
            <button
              key={f.code}
              type="button"
              aria-pressed={family === f.code}
              onClick={() => setFamily(f.code)}
              className={`rounded-lg px-2.5 py-1 text-xs font-medium transition-colors ${
                family === f.code ? "bg-sky/15 text-sky ring-1 ring-inset ring-sky/35" : "text-ink-muted hover:text-ink"
              }`}
            >
              {names.optionFamily(f.code, f.name)}
            </button>
          ))}
        </div>
        {head && (
          <p className="num text-[12px] text-ink-muted">
            {t("기초자산")} <span className="font-semibold text-ink">{fmtOption(head.symbol, head.underlying)}</span>
            <span className="text-ink-faint"> · {t("만기까지 {time}", { time: timeLeft(head.expiresAt) })}</span>
          </p>
        )}
      </div>
      <table className="tbl mt-1 w-full table-fixed">
        <thead>
          <tr>
            <th className="text-left text-up">{t("콜")}</th>
            <th className="text-center">{t("행사가")}</th>
            <th className="text-right text-down">{t("풋")}</th>
          </tr>
        </thead>
        <tbody>
          {strikes.map((s) => {
            const atm = s.strike != null && s.strike === atmStrike;
            // 내가격 쪽은 살짝 칠한다: 콜은 행사가 < 기초자산, 풋은 행사가 > 기초자산.
            const u = head?.underlying ?? null;
            const callItm = u != null && s.strike != null && s.strike < u;
            const putItm = u != null && s.strike != null && s.strike > u;
            return (
              <tr key={s.key}>
                <td className={callItm ? "bg-up/5" : undefined}>{cell(s.call, "left")}</td>
                <td className={`num text-center ${atm ? "font-semibold text-sky" : "text-ink-muted"}`}>
                  {s.call ? fmtStrike(s.call.symbol, s.strike) : "—"}
                  {atm && <span className="block text-[10px] font-normal text-ink-faint">{t("등가격")}</span>}
                </td>
                <td className={putItm ? "bg-down/5" : undefined}>{cell(s.put, "right")}</td>
              </tr>
            );
          })}
          {strikes.length === 0 && (
            <tr>
              <td colSpan={3} className="py-8 text-center text-sm text-ink-faint">
                {t("불러오는 중…")}
              </td>
            </tr>
          )}
        </tbody>
      </table>
      <p className="px-4 pb-3 pt-2 text-[11px] leading-5 text-ink-faint">
        {t("1일물 유럽형 — 매일 04:10 기초자산 가격으로 내가격이면 차액을 현금으로 받고, 외가격이면 소멸합니다. 매수와 보유분 매도만 할 수 있습니다.")}
      </p>
    </div>
  );
}
