"use client";

import type { NewsItemDto } from "@mock-kabu/shared";
import Link from "next/link";
import { formatNewsTime } from "@/lib/news";

export function NewsRow({
  item,
  showSymbol = true,
}: {
  item: NewsItemDto;
  showSymbol?: boolean;
}) {
  return (
    <li className="border-b border-hairline-soft px-4 py-3 transition-colors last:border-b-0 hover:bg-white/3">
      <div className="flex items-baseline gap-3">
        <span className="num shrink-0 text-xs text-ink-faint">{formatNewsTime(item.ts)}</span>

        {showSymbol &&
          (item.symbol ? (
            <Link
              href={`/symbol/${item.symbol}`}
              className="shrink-0 text-xs font-semibold text-ink-muted transition-colors hover:text-sky"
            >
              {item.symbolName ?? item.symbol}
            </Link>
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
  loading,
  emptyLabel = "아직 뉴스가 없습니다",
}: {
  items: readonly NewsItemDto[];
  showSymbol?: boolean;
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
        <NewsRow key={item.id} item={item} showSymbol={showSymbol} />
      ))}
    </ul>
  );
}
