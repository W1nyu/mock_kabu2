"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { clearSession, type SessionUser } from "@/lib/api";
import { useT } from "@/lib/i18n";

/**
 * 우상단 사용자 칩. 누르면 계정 설정(언어·닉네임·비밀번호)과 로그아웃 메뉴가 뜬다 —
 * 헤더에 로그아웃·언어 버튼을 따로 두지 않고 여기로 모았다.
 */
export default function UserMenu({ user }: { user: SessionUser }) {
  const t = useT();
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // 바깥 클릭·Esc로 닫는다.
  useEffect(() => {
    if (!open) return;
    const onClick = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // 메뉴에서 이동하면 닫는다.
  useEffect(() => setOpen(false), [pathname]);

  const active = open || pathname === "/settings";

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={user.nickname}
        className={`flex items-center gap-2 rounded-full border py-1 pr-1 pl-1 transition-colors sm:pr-3 ${
          active
            ? "border-sky/40 bg-sky/10"
            : "border-hairline bg-surface-2/60 hover:border-hairline-strong hover:bg-surface-3/70"
        }`}
      >
        <span className="grid h-6 w-6 place-items-center rounded-full bg-linear-to-br from-sky/80 to-indigo/80 text-[11px] font-bold text-abyss">
          {user.nickname.slice(0, 1).toUpperCase()}
        </span>
        <span className="hidden text-[13px] text-ink-muted sm:inline">{user.nickname}</span>
      </button>

      {open && (
        <div
          role="menu"
          className="glass absolute right-0 z-50 mt-2 w-52 overflow-hidden shadow-2xl"
          style={{ background: "var(--color-surface)" }}
        >
          <div className="border-b border-hairline-soft px-4 py-3">
            <div className="truncate text-sm font-medium">{user.nickname}</div>
          </div>
          <div className="p-1.5">
            <Link
              href="/settings"
              role="menuitem"
              className="block rounded-control px-3 py-2 text-[13px] text-ink-muted transition-colors hover:bg-surface-3/60 hover:text-ink"
            >
              {t("계정 설정")}
            </Link>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                clearSession();
                router.push("/login");
              }}
              className="block w-full rounded-control px-3 py-2 text-left text-[13px] text-ink-muted transition-colors hover:bg-surface-3/60 hover:text-ink"
            >
              {t("로그아웃")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
