"use client";

/**
 * 거래 페이지의 폰 전용 하단 바. 차트·호가·주문·체결이 세로로 길게 쌓이므로
 * 원하는 구역으로 바로 스크롤한다. 데스크톱(lg 이상)에서는 나오지 않는다.
 */
const SECTIONS = [
  { id: "chart", label: "차트" },
  { id: "orderbook", label: "호가" },
  { id: "order", label: "주문" },
  { id: "trades", label: "체결" },
] as const;

export default function MobileSectionBar() {
  function jump(id: string) {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  return (
    <nav
      aria-label="거래 페이지 구역 이동"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-hairline-soft bg-abyss/85 pb-[env(safe-area-inset-bottom)] backdrop-blur-glass lg:hidden"
    >
      <div className="grid grid-cols-4">
        {SECTIONS.map((section) => (
          <button
            key={section.id}
            type="button"
            onClick={() => jump(section.id)}
            className={`py-3 text-[13px] font-medium text-ink-muted transition-colors active:bg-white/6 ${
              section.id === "order" ? "text-sky" : ""
            }`}
          >
            {section.label}
          </button>
        ))}
      </div>
    </nav>
  );
}
