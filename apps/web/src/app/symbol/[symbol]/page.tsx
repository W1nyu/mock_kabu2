"use client";

import { useRouter } from "next/navigation";
import { use, useEffect, useState } from "react";
import CandleChart from "@/components/CandleChart";
import MyOpenOrders from "@/components/MyOpenOrders";
import MyPosition from "@/components/MyPosition";
import OrderForm from "@/components/OrderForm";
import Orderbook from "@/components/Orderbook";
import QuoteHeader from "@/components/QuoteHeader";
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
  const [priceHint, setPriceHint] = useState<{ symbol: string; price: number } | null>(null);
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
  const currentPriceHint = priceHint?.symbol === symbol ? priceHint.price : null;
  const currentLivePrice = livePrice?.symbol === symbol ? livePrice.price : null;

  return (
    <div className="space-y-4">
      <QuoteHeader
        symbol={symbol}
        name={currentInfo?.name}
        fallbackPrice={currentInfo?.lastPrice ?? null}
        referencePrice={currentInfo?.initialPrice ?? null}
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2 rounded-lg border border-neutral-800 bg-neutral-900 p-2">
          <CandleChart symbol={symbol} />
        </div>
        <Orderbook symbol={symbol} onPriceClick={(price) => setPriceHint({ symbol, price })} />
      </div>

      <MyPosition symbol={symbol} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <OrderForm
          key={symbol}
          symbol={symbol}
          priceHint={currentPriceHint}
          lastPrice={currentLivePrice ?? currentInfo?.lastPrice ?? null}
          onPlaced={() => setOrderRefreshKey((value) => value + 1)}
        />
        <MyOpenOrders symbol={symbol} refreshKey={orderRefreshKey} />
        <TradesFeed symbol={symbol} />
      </div>
    </div>
  );
}
