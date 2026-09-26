"use client";

import { LOCALES, type Locale } from "@mock-kabu/shared";
import { useRouter } from "next/navigation";
import { LOCALE_LABELS, useI18n } from "@/lib/i18n";

/**
 * 화면 언어 선택(한국어·English·日本語). 고르면 쿠키에 저장하고, 서버가 그린 부분(제목 등)까지 바뀌게 새로 그린다.
 * `compact`는 상단 메뉴용(언어 코드만).
 */
export default function LanguageSelect({ compact = false }: { compact?: boolean }) {
  const { locale, setLocale, t } = useI18n();
  const router = useRouter();
  return (
    <label className={compact ? "relative inline-flex items-center" : "block"}>
      <span className={compact ? "sr-only" : "label"}>{t("언어")}</span>
      <select
        value={locale}
        aria-label={t("언어")}
        onChange={(e) => {
          setLocale(e.target.value as Locale);
          router.refresh();
        }}
        className={
          compact
            ? "h-8 rounded-full border border-hairline bg-surface-2/60 pr-2 pl-2 text-[12px] font-medium text-ink-muted hover:text-ink"
            : "field"
        }
      >
        {LOCALES.map((code) => (
          <option key={code} value={code}>
            {compact ? code.toUpperCase() : LOCALE_LABELS[code]}
          </option>
        ))}
      </select>
    </label>
  );
}
