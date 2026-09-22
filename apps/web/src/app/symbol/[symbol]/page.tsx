"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import MyConditionalOrders from "@/components/MyConditionalOrders";
import MyOpenOrders from "@/components/MyOpenOrders";
import MyPosition from "@/components/MyPosition";
import MobileSectionBar from "@/components/MobileSectionBar";
import OrderForm from "@/components/OrderForm";
import Orderbook from "@/components/Orderbook";
import QuoteHeader from "@/components/QuoteHeader";
import SymbolNews from "@/components/SymbolNews";
import SymbolStrip from "@/components/SymbolStrip";
import TradesFeed from "@/components/TradesFeed";
import { api, getToken } from "@/lib/api";
import { subscribe } from "@/lib/socket";

// 캔들차트(lightweight-charts)는 클라이언트에서만 렌더하고 코드도 따로 싣는다.
const CandleChart = dynamic(() => import("@/components/CandleChart"), {
  ssr: false,
  loading: () => <div className="glass h-[24rem] animate-pulse lg:h-[28rem]" aria-hidden />,
});

interface SymbolInfo {
  symbol: string;
  name: string;
  initialPrice: number;
  lastPrice: number;
}

export default function SymbolPage({ params }: { params: Promise<{ symbol: string }> }) {
  const { symbol } = use(params);
  const router = useRouter();
  const [info, setInfo] = useState<SymbolInfo | null>(null);
  // 호가 클릭 → 주문폼·정정 중인 주문의 가격 칸. 방향(매수/매도)은 바꾸지 않는다.
  const [priceHint, setPriceHint] = useState<{ symbol: string; price: number; seq: number } | null>(null);
  const [livePrice, setLivePrice] = useState<{ symbol: string; price: number } | null>(null);
  const [orderRefreshKey, setOrderRefreshKey] = useState(0);

  useEffect(() => {
    let active = true;
    setInfo(null);
    setPriceHint(null);
    if (!getToken()) {
      router.push("/login");
      return () => {
        active = false;
      };
    }
    api<SymbolInfo[]>("/market/symbols", { auth: false })
      .then((rows) => {
        if (active) setInfo(rows.find((r) => r.symbol === symbol) ?? null);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [symbol, router]);

  useEffect(() => {
    setLivePrice(null);
    return subscribe([`trades:${symbol}`], ({ data }) => {
      if (Number.isFinite(data?.price)) setLivePrice({ symbol, price: data.price });
    });
  }, [symbol]);

  const currentInfo = info?.symbol === symbol ? info : null;
  const currentPriceHint = priceHint?.symbol === symbol ? priceHint : null;
  const currentLivePrice = livePrice?.symbol === symbol ? livePrice.price : null;

  return (
    <div className="space-y-4 pb-16 lg:pb-0">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Link
          href="/"
          className="inline-flex shrink-0 items-center gap-1.5 text-[13px] text-ink-muted transition-colors hover:text-sky"
        >
          <span aria-hidden>←</span> 대시보드
        </Link>
        <div className="min-w-0 flex-1">
          <SymbolStrip current={symbol} />
        </div>
      </div>

      <QuoteHeader
        symbol={symbol}
        name={currentInfo?.name}
        fallbackPrice={currentInfo?.lastPrice ?? null}
        referencePrice={currentInfo?.initialPrice ?? null}
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div id="chart" className="scroll-mt-28 lg:col-span-2">
          <CandleChart symbol={symbol} />
        </div>
        <div id="orderbook" className="scroll-mt-28">
          <Orderbook
            symbol={symbol}
            // 어느 쪽 호가를 눌렀든 가격만 넣는다 — 아래 호가를 눌러 매수하고 싶을 때 매도로 바뀌면 안 된다.
            onPriceClick={(price) => setPriceHint({ symbol, price, seq: Date.now() })}
          />
        </div>
      </div>

      <MyPosition symbol={symbol} onProtected={() => setOrderRefreshKey((value) => value + 1)} />

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-3">
        <div id="order" className="scroll-mt-28">
          <OrderForm
            key={symbol}
            symbol={symbol}
            priceHint={currentPriceHint}
            lastPrice={currentLivePrice ?? currentInfo?.lastPrice ?? null}
            onPlaced={() => setOrderRefreshKey((value) => value + 1)}
          />
        </div>
        <div className="space-y-4">
          <MyOpenOrders symbol={symbol} refreshKey={orderRefreshKey} priceHint={currentPriceHint} />
          <MyConditionalOrders symbol={symbol} refreshKey={orderRefreshKey} />
        </div>
        <div id="trades" className="scroll-mt-28">
          <TradesFeed symbol={symbol} />
        </div>
      </div>

      <SymbolNews symbol={symbol} />
      <MobileSectionBar />
    </div>
  );
}
