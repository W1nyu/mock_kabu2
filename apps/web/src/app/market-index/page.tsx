"use client";

import dynamic from "next/dynamic";
import Link from "next/link";

const MarketIndexPanel = dynamic(() => import("@/components/MarketIndexPanel"), {
  ssr: false,
  loading: () => <div className="glass h-[28rem] animate-pulse" aria-hidden />,
});

export default function IndexPage() {
  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div>
        {/* 폰에서는 증권 탭 안에서 들어오므로 돌아갈 길을 둔다. */}
        <Link href="/market" className="mb-2 inline-flex items-center gap-1.5 text-[13px] text-ink-muted sm:hidden">
          <span aria-hidden>←</span> 증권
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">시장 지수</h1>
      </div>
      <MarketIndexPanel />
    </div>
  );
}
