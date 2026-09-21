"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useEffect, useState } from "react";
import CandleChart from "@/components/CandleChart";
import MyConditionalOrders from "@/components/MyConditionalOrders";
import MyOpenOrders from "@/components/MyOpenOrders";
import MyPosition from "@/components/MyPosition";
import OrderForm from "@/components/OrderForm";
import Orderbook from "@/components/Orderbook";
import QuoteHeader from "@/components/QuoteHeader";
import SymbolNews from "@/components/SymbolNews";
import SymbolStrip from "@/components/SymbolStrip";
import TradesFeed from "@/components/TradesFeed";
import { api, getToken } from "@/lib/api";
import { subscribe } from "@/lib/socket";

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
  const [priceHint, setPriceHint] = useState<{ symbol: string; price: number; side: "BUY" | "SELL"; seq: number } | null>(null);
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
    <div className="space-y-4">
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
        <div className="lg:col-span-2">
          <CandleChart symbol={symbol} />
        </div>
        <Orderbook
          symbol={symbol}
          onPriceClick={(price, level) =>
            // 매도호가(ask)를 누르면 그 값에 사겠다는 뜻, 매수호가(bid)를 누르면 팔겠다는 뜻으로 본다.
            setPriceHint({ symbol, price, side: level === "ask" ? "BUY" : "SELL", seq: Date.now() })
          }
        />
      </div>

      <MyPosition symbol={symbol} onProtected={() => setOrderRefreshKey((value) => value + 1)} />

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-3">
        <OrderForm
          key={symbol}
          symbol={symbol}
          priceHint={currentPriceHint}
          lastPrice={currentLivePrice ?? currentInfo?.lastPrice ?? null}
          onPlaced={() => setOrderRefreshKey((value) => value + 1)}
        />
        <div className="space-y-4">
          <MyOpenOrders symbol={symbol} refreshKey={orderRefreshKey} />
          <MyConditionalOrders symbol={symbol} refreshKey={orderRefreshKey} />
        </div>
        <TradesFeed symbol={symbol} />
      </div>

      <SymbolNews symbol={symbol} />
    </div>
  );
}
