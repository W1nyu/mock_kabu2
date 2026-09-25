"use client";

import { industryById, industryOf, type NewsItemDto } from "@mock-kabu/shared";
import Link from "next/link";
import { formatNewsTime } from "@/lib/news";

export function NewsRow({
  item,
  showSymbol = true,
  showIndustry = true,
}: {
  item: NewsItemDto;
  showSymbol?: boolean;
  showIndustry?: boolean;
}) {
  return (
    <li className="border-b border-hairline-soft px-4 py-3 transition-colors last:border-b-0 hover:bg-surface-3/25">
      <div className="flex items-baseline gap-3">
        <span className="num shrink-0 text-xs text-ink-faint">{formatNewsTime(item.ts)}</span>

        {showSymbol &&
          (item.symbol ? (
            <span className="flex min-w-0 items-baseline gap-1.5">
              <Link
                href={`/symbol/${item.symbol}`}
                className="shrink-0 text-xs font-semibold text-ink-muted transition-colors hover:text-sky"
              >
                {item.symbolName ?? item.symbol}
              </Link>
              {showIndustry && industryOf(item.symbol) && (
                <span className="truncate text-[11px] text-ink-faint">{industryOf(item.symbol)!.label}</span>
              )}
            </span>
          ) : item.industry && industryById(item.industry) ? (
            // 산업군 전체에 대한 기사 — 특정 종목이 아니라 업종 이름을 단다.
            <span className="chip shrink-0 border-sky/30 text-sky">{industryById(item.industry)!.label}</span>
          ) : (
            <span className="chip shrink-0">시장 전체</span>
          ))}
      </div>

      <p className="mt-1 text-sm leading-snug font-medium">{item.headline}</p>
      {item.body && <p className="mt-1 text-xs leading-relaxed text-ink-muted">{item.body}</p>}
    </li>
  );
}

export function NewsList({
  items,
  showSymbol = true,
  showIndustry = true,
  loading,
  emptyLabel = "아직 뉴스가 없습니다",
}: {
  items: readonly NewsItemDto[];
  showSymbol?: boolean;
  showIndustry?: boolean;
  loading?: boolean;
  emptyLabel?: string;
}) {
  if (items.length === 0) {
    return (
      <div className="px-4 py-12 text-center text-sm text-ink-faint">
        {loading ? "뉴스를 불러오는 중…" : emptyLabel}
      </div>
    );
  }

  return (
    <ul>
      {items.map((item) => (
        <NewsRow key={item.id} item={item} showSymbol={showSymbol} showIndustry={showIndustry} />
      ))}
    </ul>
  );
}
