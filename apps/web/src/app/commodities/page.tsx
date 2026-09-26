"use client";

import { REFERENCE_ASSETS } from "@mock-kabu/shared";
import Link from "next/link";
import ReferenceList from "@/components/ReferenceList";
import { FX_CODE } from "@/lib/useReferenceRows";

const COMMODITY_CODES = REFERENCE_ASSETS.map((asset) => asset.code as string).filter((code) => code !== FX_CODE);

/** 원자재 화면 — 증권 탭의 원자재 카드에서 들어온다. 품목을 누르면 차트·관련 뉴스가 있는 상세 화면. */
export default function CommoditiesPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <Link href="/market" className="inline-flex items-center gap-1.5 text-[13px] text-ink-muted transition-colors hover:text-sky">
        <span aria-hidden>←</span> 증권
      </Link>
      <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">원자재</h1>
      <section className="glass overflow-hidden">
        <div className="panel-head">
          <span className="panel-title">원자재 가격</span>
          <span className="text-[11px] text-ink-faint">가상 지수 · 같은 이름 선물의 정산 기준</span>
        </div>
        <ReferenceList codes={COMMODITY_CODES} />
      </section>
      <p className="px-1 text-[13px] leading-6 text-ink-muted">
        원자재 가격은 시장 뉴스(유가·금속·농산물·위험 회피 등)에 반응해 움직입니다. 가격 변화에 투자하려면{" "}
        <Link href="/market?kind=futures" className="text-sky">
          선물
        </Link>
        을 이용하세요.
      </p>
    </div>
  );
}
