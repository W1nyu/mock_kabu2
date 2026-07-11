"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { clearSession, getUser, type SessionUser } from "@/lib/api";

const links = [
  { href: "/", label: "대시보드" },
  { href: "/orders", label: "주문내역" },
  { href: "/transfer", label: "이체" },
  { href: "/admin", label: "동시성 실험" },
];

export default function Nav() {
  const pathname = usePathname();
  const router = useRouter();
  const [user, setUser] = useState<SessionUser | null>(null);

  useEffect(() => {
    setUser(getUser());
  }, [pathname]);

  return (
    <nav className="flex items-center gap-6 border-b border-neutral-800 bg-neutral-900 px-6 py-3">
      <Link href="/" className="text-lg font-bold text-amber-400">
        mock<span className="text-neutral-400">kabu</span>
      </Link>
      {links.map((l) => (
        <Link
          key={l.href}
          href={l.href}
          className={`text-sm ${pathname === l.href ? "text-white" : "text-neutral-400 hover:text-neutral-200"}`}
        >
          {l.label}
        </Link>
      ))}
      <div className="ml-auto flex items-center gap-3 text-sm">
        {user ? (
          <>
            <span className="text-neutral-400">{user.nickname}</span>
            <button
              className="rounded border border-neutral-700 px-2 py-1 text-neutral-300 hover:bg-neutral-800"
              onClick={() => {
                clearSession();
                router.push("/login");
              }}
            >
              로그아웃
            </button>
          </>
        ) : (
          <Link href="/login" className="text-neutral-300 hover:text-white">
            로그인
          </Link>
        )}
      </div>
    </nav>
  );
}
