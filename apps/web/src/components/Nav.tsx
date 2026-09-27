"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { getUser, onSessionChange, type SessionUser } from "@/lib/api";
import { loadSavedTheme, setTheme, useTheme } from "@/lib/theme";
import NotificationBell from "./NotificationBell";
import UserMenu from "./UserMenu";
import { useT } from "@/lib/i18n";
import LanguageSelect from "./LanguageSelect";

/**
 * Primary customer navigation is deliberately limited to these flows.
 * `/news` was added by an explicit product decision to surface the market's
 * generated news feed; `/market-index` (equal-weight market index) likewise.
 *
 * LEGACY MENU LOCK: `/replay` and `/admin` stay routable only as contingency
 * tools for operators. Do not re-add either route to this list, link to it
 * elsewhere in the customer UI, or extend those features without an explicit
 * product decision to reopen them.
 *
 * Below `sm` these links are replaced by the bottom tab bar (MobileTabBar).
 */
const PRIMARY_NAV_LINKS = [
  { href: "/", label: "대시보드", match: (p: string) => p === "/" },
  // 폰 하단 탭의 "증권"과 같은 입구. 종목·선물 거래 화면에서도 켜 둔다.
  {
    href: "/market",
    label: "증권",
    match: (p: string) => p === "/market" || p.startsWith("/symbol/") || p.startsWith("/futures/") || p.startsWith("/reference/"),
  },
  { href: "/market-index", label: "지수", match: (p: string) => p === "/market-index" },
  { href: "/news", label: "뉴스", match: (p: string) => p === "/news" },
  { href: "/orders", label: "주문내역", match: (p: string) => p === "/orders" },
  { href: "/ranking", label: "랭킹", match: (p: string) => p === "/ranking" },
] as const;

export default function Nav() {
  const t = useT();
  const pathname = usePathname();
  const [user, setUser] = useState<SessionUser | null>(null);
  const theme = useTheme();

  useEffect(() => loadSavedTheme(), []);

  useEffect(() => {
    setUser(getUser());
  }, [pathname]);

  // 설정 페이지에서 닉네임을 바꾸면 경로 이동 없이도 칩이 따라 바뀌어야 한다.
  useEffect(() => onSessionChange(() => setUser(getUser())), []);

  return (
    <header className="sticky top-0 z-50 border-b border-hairline-soft bg-abyss/60 backdrop-blur-glass backdrop-saturate-150">
      <nav className="mx-auto flex h-14 w-full max-w-[1400px] items-center gap-2 px-4 sm:gap-4 sm:px-6">
        <Link href="/" className="group flex shrink-0 items-center gap-2.5">
          <span className="grid h-7 w-7 place-items-center rounded-[9px] bg-linear-to-br from-sky to-indigo shadow-glow transition-transform group-active:scale-95">
            <span className="h-2.5 w-2.5 rounded-[3px] bg-abyss" />
          </span>
          <span className="text-[15px] font-semibold tracking-tight">
            mock<span className="text-ink-muted"> kabu</span>
          </span>
        </Link>

        <div className="ml-2 hidden items-center gap-1 sm:flex">
          {PRIMARY_NAV_LINKS.map((l) => {
            const active = l.match(pathname);
            return (
              <Link
                key={l.href}
                href={l.href}
                aria-current={active ? "page" : undefined}
                className={`rounded-full px-3.5 py-1.5 text-[13px] font-medium transition-colors ${
                  active
                    ? "bg-sky/12 text-sky ring-1 ring-inset ring-sky/30"
                    : "text-ink-muted hover:bg-surface-3/45 hover:text-ink"
                }`}
              >
                {t(l.label)}
              </Link>
            );
          })}
        </div>

        <div className="ml-auto flex items-center gap-2">
          {/* 로그인 후 언어 변경은 계정 설정(사용자 칩)에서 한다. 로그인 전 화면에만 남긴다. */}
          {user ? null : <LanguageSelect compact />}
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            aria-label={theme === "dark" ? t("라이트 모드로 전환") : t("다크 모드로 전환")}
            title={theme === "dark" ? t("라이트 모드") : t("다크 모드")}
          >
            <span aria-hidden="true">{theme === "dark" ? "☀" : "☾"}</span>
            <span className="hidden sm:inline">{theme === "dark" ? t("라이트") : t("다크")}</span>
          </button>
          {user ? (
            <>
              <NotificationBell accountId={user.accountId} />
              {/* 사용자 칩: 계정 설정(언어 포함)·로그아웃 메뉴. 기본 메뉴 목록은 늘리지 않는다. */}
              <UserMenu user={user} />
            </>
          ) : null}
        </div>
      </nav>
    </header>
  );
}
