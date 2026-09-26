"use client";

import { industryById, industryOf, type NewsItemDto } from "@mock-kabu/shared";
import Link from "next/link";
import { formatNewsTime } from "@/lib/news";
import { useI18n, useNames, useT } from "@/lib/i18n";

export function NewsRow({
  item,
  showSymbol = true,
  showIndustry = true,
}: {
  item: NewsItemDto;
  showSymbol?: boolean;
  showIndustry?: boolean;
}) {
  const { t, locale } = useI18n();
  const names = useNames();
  // 화면 언어의 번역이 있으면 그것, 없으면(옛 기사) 한국어 원문
  const translated = locale === "ko" ? null : (item.translations?.[locale] ?? null);
  const headline = translated?.headline ?? item.headline;
  const body = translated ? translated.body : item.body;
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
                {names.symbol(item.symbol, item.symbolName ?? item.symbol)}
              </Link>
              {showIndustry && industryOf(item.symbol) && (
                <span className="truncate text-[11px] text-ink-faint">{names.industry(industryOf(item.symbol)!.id, industryOf(item.symbol)!.label)}</span>
              )}
            </span>
          ) : item.industry && industryById(item.industry) ? (
            // 산업군 전체에 대한 기사 — 특정 종목이 아니라 업종 이름을 단다.
            <span className="chip shrink-0 border-sky/30 text-sky">{names.industry(item.industry, industryById(item.industry)!.label)}</span>
          ) : (
            <span className="chip shrink-0">{t("시장 전체")}</span>
          ))}
      </div>

      <p className="mt-1 text-sm leading-snug font-medium">{headline}</p>
      {body && <p className="mt-1 text-xs leading-relaxed text-ink-muted">{body}</p>}
    </li>
  );
}

export function NewsList({
  items,
  showSymbol = true,
  showIndustry = true,
  loading,
  emptyLabel,
}: {
  items: readonly NewsItemDto[];
  showSymbol?: boolean;
  showIndustry?: boolean;
  loading?: boolean;
  emptyLabel?: string;
}) {
  const t = useT();
  if (items.length === 0) {
    return (
      <div className="px-4 py-12 text-center text-sm text-ink-faint">
        {loading ? t("뉴스를 불러오는 중…") : (emptyLabel ?? t("아직 뉴스가 없습니다"))}
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
