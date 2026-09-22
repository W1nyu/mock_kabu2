"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { clearSession, getUser, onSessionChange, type SessionUser } from "@/lib/api";
import NotificationBell from "./NotificationBell";

/**
 * Primary customer navigation is deliberately limited to these flows.
 * `/news` was added by an explicit product decision to surface the market's
 * generated news feed; `/index` (equal-weight market index) likewise.
 *
 * LEGACY MENU LOCK: `/replay` and `/admin` stay routable only as contingency
 * tools for operators. Do not re-add either route to this list, link to it
 * elsewhere in the customer UI, or extend those features without an explicit
 * product decision to reopen them.
 */
const PRIMARY_NAV_LINKS = [
  { href: "/", label: "대시보드" },
  { href: "/index", label: "지수" },
  { href: "/news", label: "뉴스" },
  { href: "/orders", label: "주문내역" },
  { href: "/transfer", label: "이체" },
] as const;

export default function Nav() {
  const pathname = usePathname();
  const router = useRouter();
  const [user, setUser] = useState<SessionUser | null>(null);

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
            const active = pathname === l.href;
            return (
              <Link
                key={l.href}
                href={l.href}
                aria-current={active ? "page" : undefined}
                className={`rounded-full px-3.5 py-1.5 text-[13px] font-medium transition-colors ${
                  active
                    ? "bg-sky/12 text-sky ring-1 ring-inset ring-sky/30"
                    : "text-ink-muted hover:bg-white/6 hover:text-ink"
                }`}
              >
                {l.label}
              </Link>
            );
          })}
        </div>

        <div className="ml-auto flex items-center gap-2">
          {user ? (
            <>
              <NotificationBell accountId={user.accountId} />
              {/* 사용자 칩은 계정 설정으로 가는 유일한 입구다 — 기본 메뉴 목록은 늘리지 않는다. */}
              <Link
                href="/settings"
                title="계정 설정 (닉네임·비밀번호)"
                aria-current={pathname === "/settings" ? "page" : undefined}
                className={`hidden items-center gap-2 rounded-full border py-1 pr-3 pl-1 transition-colors sm:flex ${
                  pathname === "/settings"
                    ? "border-sky/40 bg-sky/10"
                    : "border-hairline bg-surface-2/60 hover:border-hairline-strong hover:bg-surface-3/70"
                }`}
              >
                <span className="grid h-6 w-6 place-items-center rounded-full bg-linear-to-br from-sky/80 to-indigo/80 text-[11px] font-bold text-abyss">
                  {user.nickname.slice(0, 1).toUpperCase()}
                </span>
                <span className="text-[13px] text-ink-muted">{user.nickname}</span>
              </Link>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => {
                  clearSession();
                  router.push("/login");
                }}
              >
                로그아웃
              </button>
            </>
          ) : (
            <Link href="/login" className="btn btn-primary btn-sm">
              로그인
            </Link>
          )}
        </div>
      </nav>

      {/* Mobile row — the pill tabs move below the brand bar instead of collapsing into a tray. */}
      <div className="flex items-center gap-1 border-t border-hairline-soft px-4 py-2 sm:hidden">
        {PRIMARY_NAV_LINKS.map((l) => {
          const active = pathname === l.href;
          return (
            <Link
              key={l.href}
              href={l.href}
              aria-current={active ? "page" : undefined}
              className={`rounded-full px-3 py-1.5 text-[13px] font-medium transition-colors ${
                active
                  ? "bg-sky/12 text-sky ring-1 ring-inset ring-sky/30"
                  : "text-ink-muted hover:bg-white/6 hover:text-ink"
              }`}
            >
              {l.label}
            </Link>
          );
        })}
      </div>
    </header>
  );
}
