"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import Leaderboard from "@/components/Leaderboard";
import { getToken } from "@/lib/api";

/** 투자자 랭킹 — 예전 이체 메뉴 자리. 대시보드에 있던 랭킹을 상위 50등까지 넓혀 보여 준다. */
export default function RankingPage() {
  const router = useRouter();

  useEffect(() => {
    if (!getToken()) router.push("/login");
  }, [router]);

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">랭킹</h1>
      <Leaderboard topN={50} showMine />
      <p className="px-1 text-[12px] leading-5 text-ink-faint">
        봇 계정은 제외됩니다. 오늘·1주는 기간 시작 자산 대비, 전체는 가입 이후 순입금 대비 수익률입니다.
      </p>
    </div>
  );
}
