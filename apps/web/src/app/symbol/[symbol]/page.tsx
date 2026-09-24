"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useCallback, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import MyConditionalOrders from "@/components/MyConditionalOrders";
import MyOpenOrders from "@/components/MyOpenOrders";
import MyPosition from "@/components/MyPosition";
import MobileOrderSheet, { MobileTradeBar } from "@/components/MobileOrderSheet";
import OrderForm from "@/components/OrderForm";
import Orderbook from "@/components/Orderbook";
import QuoteHeader from "@/components/QuoteHeader";
import SymbolNews from "@/components/SymbolNews";
import SymbolStrip from "@/components/SymbolStrip";
import TradesFeed from "@/components/TradesFeed";
import { api, getToken } from "@/lib/api";
import { COMPACT_TRADE_QUERY, useMediaQuery } from "@/lib/media";
import { subscribe } from "@/lib/socket";

// 캔들차트(lightweight-charts)는 클라이언트에서만 렌더하고 코드도 따로 싣는다.
const CandleChart = dynamic(() => import("@/components/CandleChart"), {
  ssr: false,
  loading: () => <div className="glass h-[24rem] animate-pulse lg:h-[28rem]" aria-hidden />,
});

interface SymbolInfo {
  symbol: string;
  name: string;
  referencePrice: number;
  lastPrice: number;
}

interface MaintenanceStatus {
  active: boolean;
  startAt: string;
  endAt: string;
  timezone: string;
}

type MobileTab = "orders" | "trades" | "news";
const MOBILE_TABS: { id: MobileTab; label: string }[] = [
  { id: "orders", label: "내 주문" },
  { id: "trades", label: "체결" },
  { id: "news", label: "뉴스" },
];

export default function SymbolPage({ params }: { params: Promise<{ symbol: string }> }) {
  const { symbol } = use(params);
  const router = useRouter();
  const [info, setInfo] = useState<SymbolInfo | null>(null);
  // 호가 클릭 → 주문폼·정정 중인 주문의 가격 칸. 방향(매수/매도)은 바꾸지 않는다.
  const [priceHint, setPriceHint] = useState<{ symbol: string; price: number; seq: number } | null>(null);
  const [livePrice, setLivePrice] = useState<{ symbol: string; price: number } | null>(null);
  const [orderRefreshKey, setOrderRefreshKey] = useState(0);
  const [maintenance, setMaintenance] = useState<MaintenanceStatus | null>(null);
  // 폰(lg 미만)에서는 차트 위주로 보여 주고, 호가·주문은 하단 매수/매도 버튼이 여는 시트에 둔다.
  const compact = useMediaQuery(COMPACT_TRADE_QUERY);
  const [sheet, setSheet] = useState<{ symbol: string; side: "BUY" | "SELL"; seq: number } | null>(null);
  const [mobileTab, setMobileTab] = useState<MobileTab>("orders");
  const closeSheet = useCallback(() => setSheet(null), []);

  useEffect(() => {
    let active = true;
    const refresh = () => {
      api<MaintenanceStatus>("/health/maintenance", { auth: false })
        .then((status) => { if (active) setMaintenance(status); })
        .catch(() => {});
    };
    refresh();
    const timer = setInterval(refresh, 5_000);
    return () => { active = false; clearInterval(timer); };
  }, []);

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
  const currentSheet = compact && sheet?.symbol === symbol ? sheet : null;
  const lastPrice = currentLivePrice ?? currentInfo?.lastPrice ?? null;
  const onPriceClick = (price: number) => setPriceHint({ symbol, price, seq: Date.now() });
  const onPlaced = () => setOrderRefreshKey((value) => value + 1);

  return (
    <div className="space-y-4 sm:max-lg:pb-20">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Link
          href={compact ? "/market" : "/"}
          className="inline-flex shrink-0 items-center gap-1.5 text-[13px] text-ink-muted transition-colors hover:text-sky"
        >
          <span aria-hidden>←</span> {compact ? "증권" : "대시보드"}
        </Link>
        <div className="min-w-0 flex-1">
          <SymbolStrip current={symbol} />
        </div>
      </div>

      {maintenance?.active ? (
        <section className="glass flex min-h-[24rem] flex-col items-center justify-center gap-4 px-6 py-12 text-center" role="status" aria-live="polite">
          <span className="rounded-full border border-warn/40 bg-warn/10 px-4 py-1 text-sm font-semibold text-warn">거래 점검 중</span>
          <h1 className="text-2xl font-bold text-ink">잠시 주식 거래를 멈췄습니다</h1>
          <p className="max-w-lg text-sm leading-7 text-ink-muted">
            매일 04:10~04:20(한국 시간)에는 주문과 시세 화면을 잠시 멈추고 서버를 정리합니다.
            기존 주문과 잔고는 유지됩니다. 오전 4시 20분부터 다시 이용할 수 있습니다.
          </p>
        </section>
      ) : (
      <>
      <QuoteHeader
        symbol={symbol}
        name={currentInfo?.name}
        fallbackPrice={currentInfo?.lastPrice ?? null}
        referencePrice={currentInfo?.referencePrice ?? null}
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <CandleChart symbol={symbol} />
        </div>
        {compact === false && (
          <Orderbook
            symbol={symbol}
            // 어느 쪽 호가를 눌렀든 가격만 넣는다 — 아래 호가를 눌러 매수하고 싶을 때 매도로 바뀌면 안 된다.
            onPriceClick={onPriceClick}
          />
        )}
      </div>

      <MyPosition symbol={symbol} onProtected={onPlaced} />

      {compact === false && (
        <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-3">
          <OrderForm
            key={symbol}
            symbol={symbol}
            priceHint={currentPriceHint}
            lastPrice={lastPrice}
            onPlaced={onPlaced}
          />
          <div className="space-y-4">
            <MyOpenOrders symbol={symbol} refreshKey={orderRefreshKey} priceHint={currentPriceHint} />
            <MyConditionalOrders symbol={symbol} refreshKey={orderRefreshKey} />
          </div>
          <TradesFeed symbol={symbol} />
        </div>
      )}
      {compact === false && <SymbolNews symbol={symbol} />}

      {compact === true && (
        <>
          <div className="well grid grid-cols-3 gap-1 p-1" role="tablist" aria-label="종목 정보">
            {MOBILE_TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={mobileTab === tab.id}
                onClick={() => setMobileTab(tab.id)}
                className={`rounded-lg py-2 text-[13px] font-medium transition-colors ${
                  mobileTab === tab.id ? "bg-surface-3/70 text-ink shadow-sm" : "text-ink-muted"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
          {mobileTab === "orders" && (
            <div className="space-y-4">
              <MyOpenOrders symbol={symbol} refreshKey={orderRefreshKey} priceHint={currentPriceHint} />
              <MyConditionalOrders symbol={symbol} refreshKey={orderRefreshKey} />
            </div>
          )}
          {mobileTab === "trades" && <TradesFeed symbol={symbol} />}
          {mobileTab === "news" && <SymbolNews symbol={symbol} />}

          <MobileTradeBar
            onOpen={(side) => {
              // 이전에 눌렀던 호가 가격이 새 주문폼에 끼어들지 않게 비운다.
              setPriceHint(null);
              setSheet({ symbol, side, seq: Date.now() });
            }}
          />
          {currentSheet && (
            <MobileOrderSheet
              key={currentSheet.seq}
              symbol={symbol}
              name={currentInfo?.name}
              side={currentSheet.side}
              priceHint={currentPriceHint}
              lastPrice={lastPrice}
              onPriceClick={onPriceClick}
              onPlaced={onPlaced}
              onClose={closeSheet}
            />
          )}
        </>
      )}
      </>
      )}
    </div>
  );
}
