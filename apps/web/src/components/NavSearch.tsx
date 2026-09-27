"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { searchSymbols, type SearchEntry, type SearchKind } from "@/lib/symbol-search";
import { useNames, useT } from "@/lib/i18n";

/**
 * 상단 메뉴 종목 검색. 넓은 화면(lg 이상)은 메뉴 줄에 입력칸, 그보다 좁으면 돋보기 버튼이 헤더 아래 검색 패널을 연다.
 * `/` 키로 어느 화면에서든 검색을 연다(입력 중일 때는 제외).
 */
const KIND_LABELS: Record<SearchKind, string> = { stock: "현물", future: "선물", reference: "환율·원자재" };

export default function NavSearch() {
  const t = useT();
  const pathname = usePathname();
  const [panelOpen, setPanelOpen] = useState(false);
  const inlineRef = useRef<HTMLInputElement>(null);

  // 화면을 옮기면 패널을 닫는다.
  useEffect(() => setPanelOpen(false), [pathname]);

  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      e.preventDefault();
      if (inlineRef.current && inlineRef.current.offsetParent !== null) inlineRef.current.focus();
      else setPanelOpen(true);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <>
      <div className="relative hidden w-56 lg:block">
        <SearchBox inputRef={inlineRef} />
      </div>
      <button
        type="button"
        className="btn btn-ghost btn-sm lg:hidden"
        aria-label={t("종목 검색")}
        aria-expanded={panelOpen}
        onClick={() => setPanelOpen((v) => !v)}
      >
        <SearchIcon />
      </button>
      {panelOpen && (
        <>
          <div className="fixed inset-0 top-14 z-40 bg-abyss/40 lg:hidden" onClick={() => setPanelOpen(false)} />
          <div className="fixed inset-x-0 top-14 z-50 border-b border-hairline-soft bg-abyss/95 px-4 py-3 backdrop-blur-glass lg:hidden">
            <div className="relative mx-auto max-w-xl">
              <SearchBox autoFocus onClose={() => setPanelOpen(false)} />
            </div>
          </div>
        </>
      )}
    </>
  );
}

function SearchBox({
  inputRef,
  autoFocus,
  onClose,
}: {
  inputRef?: React.RefObject<HTMLInputElement | null>;
  autoFocus?: boolean;
  onClose?: () => void;
}) {
  const t = useT();
  const names = useNames();
  const router = useRouter();
  const listId = useId();
  const [query, setQuery] = useState("");
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState(0);
  const results = useMemo(() => searchSymbols(query), [query]);
  const showList = focused && query.trim().length > 0;

  useEffect(() => setActive(0), [query]);

  function label(item: SearchEntry): string {
    if (item.kind === "stock") return names.symbol(item.code, item.name);
    if (item.kind === "future") return names.future(item.code, item.name);
    return names.reference(item.code, item.name);
  }

  function go(item: SearchEntry) {
    setQuery("");
    (document.activeElement as HTMLElement | null)?.blur();
    onClose?.();
    router.push(item.href);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" && results.length > 0) {
      e.preventDefault();
      setActive((i) => (i + 1) % results.length);
    } else if (e.key === "ArrowUp" && results.length > 0) {
      e.preventDefault();
      setActive((i) => (i - 1 + results.length) % results.length);
    } else if (e.key === "Enter" && results[active]) {
      e.preventDefault();
      go(results[active]);
    } else if (e.key === "Escape") {
      setQuery("");
      e.currentTarget.blur();
      onClose?.();
    }
  }

  return (
    <>
      <label className="flex h-9 items-center gap-2 rounded-full border border-hairline bg-surface-2/60 px-3 text-ink-muted transition-colors focus-within:border-sky/50 focus-within:bg-surface-2">
        <SearchIcon />
        <input
          ref={inputRef}
          type="search"
          value={query}
          autoFocus={autoFocus}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => setFocused(true)}
          // 결과를 누르는 동안 목록이 사라지지 않게 onMouseDown에서 이동한다.
          onBlur={() => setFocused(false)}
          onKeyDown={onKeyDown}
          placeholder={t("종목 검색")}
          aria-label={t("종목 검색")}
          role="combobox"
          aria-expanded={showList}
          aria-controls={listId}
          aria-activedescendant={showList && results[active] ? `${listId}-${active}` : undefined}
          autoComplete="off"
          spellCheck={false}
          // 전역 :focus-visible 테두리는 레이어 밖이라 클래스로 못 끈다 — 테두리는 감싼 label이 보여 준다.
          style={{ outline: "none" }}
          // 폰은 16px 미만이면 iOS가 확대한다(.field와 같은 이유).
          className="min-w-0 flex-1 bg-transparent text-base text-ink placeholder:text-ink-faint lg:text-[13px] [&::-webkit-search-cancel-button]:hidden"
        />
        <kbd className="hidden rounded border border-hairline px-1.5 text-[10px] text-ink-faint lg:inline">/</kbd>
      </label>
      {showList && (
        <ul
          id={listId}
          role="listbox"
          className="absolute inset-x-0 top-full z-50 mt-1.5 max-h-[60vh] overflow-y-auto rounded-xl border border-hairline bg-surface py-1 shadow-lg"
        >
          {results.length === 0 && <li className="px-3 py-3 text-center text-[13px] text-ink-faint">{t("검색 결과가 없습니다")}</li>}
          {results.map((item, i) => (
            <li
              key={item.href}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => {
                e.preventDefault();
                go(item);
              }}
              onMouseEnter={() => setActive(i)}
              className={`flex cursor-pointer items-center gap-2 px-3 py-2 text-[13px] ${i === active ? "bg-surface-3/60" : ""}`}
            >
              <span className="min-w-0 flex-1 truncate font-medium text-ink">{label(item)}</span>
              <span className="num shrink-0 text-xs text-ink-faint">{item.code}</span>
              <span className="w-16 shrink-0 text-right text-[11px] text-ink-faint">{t(KIND_LABELS[item.kind])}</span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function SearchIcon() {
  return (
    <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}
