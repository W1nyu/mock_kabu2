"use client";

import { referenceAsset } from "@mock-kabu/shared";
import Link from "next/link";
import { use, useEffect, useState } from "react";
import AssetNews from "@/components/AssetNews";
import ReferenceChart from "@/components/ReferenceChart";
import { api } from "@/lib/api";
import { formatReference, parseReferenceTick, referenceChange, type ReferenceRow } from "@/lib/reference";
import { subscribe } from "@/lib/socket";
import { everyVisible } from "@/lib/visible-interval";

/** 어떤 뉴스가 이 가격을 움직이는지 — 사용자가 뉴스와 가격을 이어서 볼 수 있게 적어 둔다. */
const DRIVERS: Record<string, string> = {
  USDKRW: "환율 관련 시장 뉴스(원·달러 급등락, 외환당국 개입, 달러 강세 등)에 반응합니다.",
  OIL: "유가 관련 시장 뉴스(OPEC 감산·증산, 중동 리스크, 수요 둔화 등)에 반응합니다.",
  GAS: "유가·에너지 뉴스에 일부 반응하고, 천연가스를 직접 다룬 기사에 크게 반응합니다.",
  COPPER: "원자재·산업금속 뉴스(중국 경기, 인프라 투자, 금속 재고 등)에 반응하고, 구리를 직접 다룬 기사에 크게 반응합니다.",
};

export default function ReferencePage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = use(params);
  const def = referenceAsset(code);
  const [row, setRow] = useState<ReferenceRow | null>(null);
  const [value, setValue] = useState<number | null>(null);

  useEffect(() => {
    if (!def) return;
    let active = true;
    const load = () =>
      api<ReferenceRow[]>("/market/reference", { auth: false })
        .then((rows) => {
          const found = rows.find((r) => r.code === def.code) ?? null;
          if (active && found) {
            setRow(found);
            setValue((current) => current ?? found.value);
          }
        })
        .catch(() => {});
    load();
    const stop = everyVisible(load, 30_000);
    const unsubscribe = subscribe([`ref:${def.code}`], ({ data }) => {
      const tick = parseReferenceTick(data);
      if (tick && active) setValue(tick.value);
    });
    return () => {
      active = false;
      stop();
      unsubscribe();
    };
  }, [def]);

  if (!def) {
    return (
      <div className="mx-auto max-w-3xl py-16 text-center text-sm text-ink-muted">
        없는 기초자산입니다. <Link href="/market" className="text-sky">증권으로 돌아가기</Link>
      </div>
    );
  }

  const shown = value ?? row?.value ?? null;
  const change = referenceChange(shown, row?.base ?? null);
  const tone = change == null ? "text-ink-faint" : change > 0 ? "text-up" : change < 0 ? "text-down" : "text-ink-muted";

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <Link
        href="/market?kind=futures"
        className="inline-flex items-center gap-1.5 text-[13px] text-ink-muted transition-colors hover:text-sky"
      >
        <span aria-hidden>←</span> 선물·원자재
      </Link>
      <div className="glass p-4 sm:p-5">
        <p className="text-[13px] text-ink-muted">
          {def.code} · 선물 기초자산 <span className="text-ink-faint">(가상 지수)</span>
        </p>
        <h1 className="mt-1 text-xl font-semibold tracking-tight sm:text-2xl">{def.name}</h1>
        <p className="num mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">{formatReference(shown, def)}</p>
        <p className={`num mt-0.5 text-sm font-medium ${tone}`}>
          {change == null ? "—" : `${change > 0 ? "+" : ""}${change.toFixed(2)}% 오늘`}
        </p>
      </div>

      <section className="glass p-3 sm:p-4">
        <ReferenceChart code={def.code} scale={def.scale} decimals={def.decimals} />
      </section>
      <AssetNews reference={def.code} />

      <p className="px-1 text-[13px] leading-6 text-ink-muted">
        {DRIVERS[def.code]} 이 가격은 모의 시장이 만드는 가상 지수이며, 곧 추가될 선물의 정산 기준이 됩니다.
      </p>
    </div>
  );
}
