"use client";

import { useRouter } from "next/navigation";
import { use, useEffect, useState } from "react";
import CandleChart from "@/components/CandleChart";
import MyOpenOrders from "@/components/MyOpenOrders";
import MyPosition from "@/components/MyPosition";
import OrderForm from "@/components/OrderForm";
import Orderbook from "@/components/Orderbook";
import TradesFeed from "@/components/TradesFeed";
import { api, getToken } from "@/lib/api";

interface SymbolInfo {
  symbol: string;
  name: string;
  lastPrice: number;
}

export default function SymbolPage({ params }: { params: Promise<{ symbol: string }> }) {
  const { symbol } = use(params);
  const router = useRouter();
  const [info, setInfo] = useState<SymbolInfo | null>(null);
  const [priceHint, setPriceHint] = useState<number | null>(null);

  useEffect(() => {
    if (!getToken()) {
      router.push("/login");
      return;
    }
    api<SymbolInfo[]>("/market/symbols", { auth: false })
      .then((rows) => setInfo(rows.find((r) => r.symbol === symbol) ?? null))
      .catch(() => {});
  }, [symbol, router]);

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">
        {symbol} <span className="text-base font-normal text-neutral-400">{info?.name}</span>
      </h1>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2 rounded-lg border border-neutral-800 bg-neutral-900 p-2">
          <CandleChart symbol={symbol} />
        </div>
        <Orderbook symbol={symbol} onPriceClick={setPriceHint} />
      </div>

      <MyPosition symbol={symbol} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <OrderForm symbol={symbol} priceHint={priceHint} />
        <MyOpenOrders symbol={symbol} />
        <TradesFeed symbol={symbol} />
      </div>
    </div>
  );
}
