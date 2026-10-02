"use client";

import { useEffect, useRef, type ReactNode } from "react";
import FuturesBook from "./FuturesBook";
import { useT } from "@/lib/i18n";

/**
 * 폰 선물·옵션 주문 시트 — 현물 MobileOrderSheet와 같은 모양: 위는 호가(누르면 가격 입력), 아래는 주문창(children).
 * 하단 매수/매도 바(MobileTradeBar)가 연다.
 */
export default function DerivOrderSheet({
  symbol,
  name,
  onPick,
  onClose,
  children,
}: {
  symbol: string;
  name: string;
  onPick: (price: number) => void;
  onClose: () => void;
  /** 주문창(FuturesOrderPanel·OptionOrderPanel) */
  children: ReactNode;
}) {
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

  // 호가창은 항상 매도·매수 5단씩 그려 높이가 고정이므로, 가운데로 맞추면 매도·매수 경계가 보인다.
  const bookRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const el = bookRef.current;
      if (el) el.scrollTop = (el.scrollHeight - el.clientHeight) / 2;
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  const t = useT();
  return (
    <div className="fixed inset-0 z-[60] lg:hidden" role="dialog" aria-modal="true" aria-label={t("{name} 주문", { name })}>
      <button
        type="button"
        aria-label={t("주문 창 닫기")}
        className="absolute inset-0 animate-[sheet-fade_180ms_ease-out] bg-black/55"
        onClick={onClose}
      />
      <div className="absolute inset-x-0 bottom-0 flex h-[92dvh] animate-[sheet-up_240ms_cubic-bezier(0.2,0.8,0.2,1)] flex-col overflow-hidden rounded-t-2xl border-t border-hairline bg-abyss shadow-2xl">
        <div className="flex shrink-0 items-center gap-3 px-4 pt-2 pb-2">
          <div className="min-w-0 flex-1">
            <span className="mx-auto mb-2 block h-1 w-10 rounded-full bg-surface-3" aria-hidden />
            <p className="truncate text-[15px] font-semibold">
              {name} <span className="num text-xs font-normal text-ink-faint">{symbol}</span>
            </p>
          </div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
            {t("닫기")}
          </button>
        </div>
        <div ref={bookRef} className="max-h-[38%] shrink-0 overflow-y-auto overscroll-contain px-3">
          <FuturesBook symbol={symbol} onPick={onPick} />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pt-3 pb-[calc(1rem+env(safe-area-inset-bottom))]">
          {children}
        </div>
      </div>
    </div>
  );
}
