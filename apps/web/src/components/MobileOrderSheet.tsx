"use client";

import { useEffect, useRef } from "react";
import OrderForm from "./OrderForm";
import Orderbook from "./Orderbook";

type Side = "BUY" | "SELL";

/**
 * 폰 거래 화면 하단 고정 바. 차트를 본 뒤 여기서 매도/매수를 누르면 주문 시트가 열린다.
 * 매수(빨강)가 왼쪽, 매도(파랑)가 오른쪽 — 주문폼의 매수/매도 순서와 같다.
 */
export function MobileTradeBar({ onOpen }: { onOpen: (side: Side) => void }) {
  return (
    <div className="fixed inset-x-0 bottom-0 z-40 border-t border-hairline-soft bg-abyss/90 px-4 pt-2.5 pb-[calc(0.625rem+env(safe-area-inset-bottom))] backdrop-blur-glass lg:hidden">
      <div className="mx-auto grid max-w-xl grid-cols-2 gap-2">
        <button type="button" className="btn btn-buy h-12 text-[15px]" onClick={() => onOpen("BUY")}>
          매수
        </button>
        <button type="button" className="btn btn-sell h-12 text-[15px]" onClick={() => onOpen("SELL")}>
          매도
        </button>
      </div>
    </div>
  );
}

/**
 * 아래에서 올라오는 주문 시트: 위쪽은 호가창(체결가가 가운데 오도록 스크롤), 아래쪽은 주문폼.
 * 두 영역은 각자 스크롤되어 호가를 보면서 수량·가격을 입력할 수 있다.
 */
export default function MobileOrderSheet({
  symbol,
  name,
  side,
  priceHint,
  lastPrice,
  onPriceClick,
  onPlaced,
  onClose,
}: {
  symbol: string;
  name?: string;
  side: Side;
  priceHint: { price: number; seq: number } | null;
  lastPrice: number | null;
  onPriceClick: (price: number) => void;
  onPlaced: () => void;
  onClose: () => void;
}) {
  const bookRef = useRef<HTMLDivElement>(null);

  // 시트가 열린 동안 뒤 페이지가 같이 스크롤되지 않게 하고, Esc로 닫는다.
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  // 호가창은 항상 매도·매수 8단씩 그려 높이가 고정이므로, 가운데로 맞추면 체결가 줄이 보인다.
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const el = bookRef.current;
      if (el) el.scrollTop = (el.scrollHeight - el.clientHeight) / 2;
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <div className="fixed inset-0 z-[60] lg:hidden" role="dialog" aria-modal="true" aria-label={`${name ?? symbol} 주문`}>
      <button
        type="button"
        aria-label="주문 창 닫기"
        className="absolute inset-0 animate-[sheet-fade_180ms_ease-out] bg-black/55"
        onClick={onClose}
      />
      <div className="absolute inset-x-0 bottom-0 flex h-[92dvh] animate-[sheet-up_240ms_cubic-bezier(0.2,0.8,0.2,1)] flex-col overflow-hidden rounded-t-2xl border-t border-hairline bg-abyss shadow-2xl">
        <div className="flex shrink-0 items-center gap-3 px-4 pt-2 pb-2">
          <div className="min-w-0 flex-1">
            <span className="mx-auto mb-2 block h-1 w-10 rounded-full bg-surface-3" aria-hidden />
            <p className="truncate text-[15px] font-semibold">
              {name ?? symbol} <span className="num text-xs font-normal text-ink-faint">{symbol}</span>
            </p>
          </div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
            닫기
          </button>
        </div>

        <div ref={bookRef} className="max-h-[38%] shrink-0 overflow-y-auto overscroll-contain px-3">
          <Orderbook symbol={symbol} onPriceClick={(price) => onPriceClick(price)} />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pt-3 pb-[calc(1rem+env(safe-area-inset-bottom))]">
          <OrderForm
            symbol={symbol}
            initialSide={side}
            priceHint={priceHint}
            lastPrice={lastPrice}
            onPlaced={onPlaced}
          />
        </div>
      </div>
    </div>
  );
}
