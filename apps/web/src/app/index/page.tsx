"use client";

import dynamic from "next/dynamic";

const MarketIndexPanel = dynamic(() => import("@/components/MarketIndexPanel"), {
  ssr: false,
  loading: () => <div className="glass h-[28rem] animate-pulse" aria-hidden />,
});

export default function IndexPage() {
  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">시장 지수</h1>
        <p className="mt-1 text-sm text-ink-muted">
          모든 종목을 시초가 기준 균등 비율로 묶은 지수. 각 종목의 현재가 ÷ 시초가를 평균해 기준 1,000으로 환산한다.
        </p>
      </div>
      <MarketIndexPanel />
    </div>
  );
}
