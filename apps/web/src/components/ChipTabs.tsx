"use client";

import { useEffect, useRef, type ReactNode } from "react";

export interface ChipTabItem {
  id: string;
  label: string;
  /** 라벨 옆 보조 표시 (예: 산업군 평균 등락률) */
  hint?: ReactNode;
}

/**
 * 단일 선택 칩 줄. 폰에서는 가로 스크롤(`chip-scroller`)이고 선택된 칩이 보이도록 스크롤을 옮긴다.
 * 칩 높이는 폰 36px 이상으로 엄지 터치 영역을 확보하고, 데스크톱에서는 조금 줄인다.
 */
export default function ChipTabs({
  items,
  value,
  onChange,
  label,
  size = "md",
}: {
  items: readonly ChipTabItem[];
  value: string;
  onChange: (id: string) => void;
  label: string;
  size?: "md" | "sm";
}) {
  const rowRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const active = rowRef.current?.querySelector<HTMLElement>('[aria-pressed="true"]');
    const row = rowRef.current;
    // 폰 가로 스크롤 줄에서만 선택 칩을 가운데로 — 페이지 세로 스크롤은 건드리지 않는다.
    if (!row || !active || row.scrollWidth <= row.clientWidth) return;
    const rowBox = row.getBoundingClientRect();
    const chipBox = active.getBoundingClientRect();
    const left = row.scrollLeft + chipBox.left - rowBox.left - (rowBox.width - chipBox.width) / 2;
    row.scrollTo({ left, behavior: "smooth" });
  }, [value]);

  return (
    <div ref={rowRef} role="group" aria-label={label} className="chip-scroller">
      {items.map((item) => {
        const active = item.id === value;
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => onChange(item.id)}
            aria-pressed={active}
            className={`inline-flex items-center gap-1.5 rounded-full font-medium whitespace-nowrap transition-colors ${
              size === "sm"
                ? "min-h-8 px-3 text-[12px] sm:min-h-7"
                : "min-h-9 px-3.5 text-[13px] sm:min-h-8"
            } ${
              active
                ? "bg-sky/12 text-sky ring-1 ring-sky/30 ring-inset"
                : "text-ink-muted ring-1 ring-hairline-soft ring-inset hover:bg-surface-3/45 hover:text-ink"
            }`}
          >
            {item.label}
            {item.hint}
          </button>
        );
      })}
    </div>
  );
}
