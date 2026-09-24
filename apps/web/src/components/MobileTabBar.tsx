"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * 폰 전용 하단 탭 (sm 미만). 데스크톱 상단 메뉴와 같은 페이지로 가지만, 폰에서는 증권 앱처럼
 * 엄지가 닿는 아래에 둔다. 지수는 `/market`(증권) 안에서 들어간다.
 * 거래 화면(`/symbol/*`)에서는 매수/매도 버튼이 이 자리를 쓰므로 숨긴다.
 */
const TABS = [
  { href: "/", label: "홈", icon: HomeIcon, match: (p: string) => p === "/" },
  {
    href: "/market",
    label: "증권",
    icon: ChartIcon,
    match: (p: string) => p === "/market" || p === "/market-index",
  },
  { href: "/news", label: "뉴스", icon: NewsIcon, match: (p: string) => p === "/news" },
  { href: "/orders", label: "내역", icon: ListIcon, match: (p: string) => p === "/orders" },
  { href: "/transfer", label: "이체", icon: TransferIcon, match: (p: string) => p === "/transfer" },
] as const;

const HIDDEN_PREFIXES = ["/symbol/", "/login", "/signup"];

export default function MobileTabBar() {
  const pathname = usePathname();
  if (HIDDEN_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return null;

  return (
    <nav
      aria-label="주요 메뉴"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-hairline-soft bg-abyss/90 pb-[env(safe-area-inset-bottom)] backdrop-blur-glass sm:hidden"
    >
      <div className="grid grid-cols-5">
        {TABS.map(({ href, label, icon: Icon, match }) => {
          const active = match(pathname);
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? "page" : undefined}
              className={`flex flex-col items-center gap-1 pt-2 pb-1.5 text-[11px] font-medium transition-colors active:bg-surface-3/45 ${
                active ? "text-ink" : "text-ink-faint"
              }`}
            >
              <Icon active={active} />
              {label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}

function Svg({ children, active }: { children: React.ReactNode; active: boolean }) {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={active ? 2.2 : 1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  );
}

function HomeIcon({ active }: { active: boolean }) {
  return (
    <Svg active={active}>
      <path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z" />
    </Svg>
  );
}

function ChartIcon({ active }: { active: boolean }) {
  return (
    <Svg active={active}>
      <path d="M3 3v18h18" />
      <path d="m7 15 4-4 3 3 6-7" />
    </Svg>
  );
}

function NewsIcon({ active }: { active: boolean }) {
  return (
    <Svg active={active}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M7 8h10M7 12h10M7 16h6" />
    </Svg>
  );
}

function ListIcon({ active }: { active: boolean }) {
  return (
    <Svg active={active}>
      <path d="M9 6h11M9 12h11M9 18h11" />
      <circle cx="4.5" cy="6" r="1" />
      <circle cx="4.5" cy="12" r="1" />
      <circle cx="4.5" cy="18" r="1" />
    </Svg>
  );
}

function TransferIcon({ active }: { active: boolean }) {
  return (
    <Svg active={active}>
      <path d="M4 8h14l-4-4M20 16H6l4 4" />
    </Svg>
  );
}
