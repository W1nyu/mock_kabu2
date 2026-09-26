"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  clearNotifications,
  lastReadAt,
  listNotifications,
  markAllRead,
  onNotificationsChange,
  type NotificationItem,
} from "@/lib/notifications";
import { formatKstTime } from "@/lib/time";
import { useT } from "@/lib/i18n";

const TONE_DOT: Record<NotificationItem["tone"], string> = {
  up: "bg-up",
  down: "bg-down",
  info: "bg-sky",
  warn: "bg-warn",
};

/** Nav의 종 아이콘. 안 읽은 알림 수를 배지로, 클릭하면 최근 알림 목록을 드롭다운으로 연다. */
export default function NotificationBell({ accountId }: { accountId: string }) {
  const t = useT();
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [readAt, setReadAt] = useState(0);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const load = () => {
      setItems(listNotifications(accountId));
      setReadAt(lastReadAt(accountId));
    };
    load();
    return onNotificationsChange(load);
  }, [accountId]);

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

  const unread = items.filter((item) => item.ts > readAt).length;

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next) markAllRead(accountId);
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={toggle}
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={unread > 0 ? t("알림 {n}건 안 읽음", { n: unread }) : t("알림")}
        title={t("알림")}
        className={`relative grid h-8 w-8 place-items-center rounded-full border transition-colors ${
          open ? "border-sky/40 bg-sky/10 text-ink" : "border-hairline bg-surface-2/60 text-ink-muted hover:text-ink"
        }`}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.7 21a2 2 0 0 1-3.4 0" />
        </svg>
        {unread > 0 && (
          <span className="num absolute -top-1 -right-1 grid h-4 min-w-4 place-items-center rounded-full bg-up px-1 text-[10px] font-bold text-abyss">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div
          // 폰: 종 버튼 옆 기준으로 펼치면 화면 왼쪽이 잘린다 — 헤더 아래에 화면 폭(양옆 8px)으로 고정한다.
          className="glass z-50 overflow-hidden shadow-2xl max-sm:fixed max-sm:inset-x-2 max-sm:top-16 sm:absolute sm:right-0 sm:mt-2 sm:w-[22rem]"
          style={{ background: "var(--color-surface)" }}
        >
          <div className="panel-head">
            <span className="panel-title">{t("알림")}</span>
            {items.length > 0 && (
              <button
                type="button"
                onClick={() => clearNotifications(accountId)}
                className="text-[11px] text-ink-faint transition-colors hover:text-ink"
              >
                {t("모두 지우기")}
              </button>
            )}
          </div>
          <ul className="max-h-80 overflow-y-auto overscroll-contain text-xs max-sm:max-h-[min(70dvh,32rem)]">
            {items.map((item) => {
              const body = (
                <>
                  <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${TONE_DOT[item.tone]}`} />
                  <span className="min-w-0 flex-1">
                    <span className="num block font-medium">{item.title}</span>
                    {item.detail && <span className="num block text-ink-muted">{item.detail}</span>}
                  </span>
                  <span className="num shrink-0 text-ink-faint">{formatKstTime(item.ts).slice(0, 5)}</span>
                </>
              );
              const className = `flex items-start gap-2 border-b border-hairline-soft px-4 py-2 last:border-b-0 ${
                item.ts > readAt ? "bg-surface-3/20" : ""
              }`;
              return (
                <li key={item.id}>
                  {item.href ? (
                    <Link href={item.href} onClick={() => setOpen(false)} className={`${className} transition-colors hover:bg-surface-3/45`}>
                      {body}
                    </Link>
                  ) : (
                    <div className={className}>{body}</div>
                  )}
                </li>
              );
            })}
            {items.length === 0 && <li className="px-4 py-8 text-center text-ink-faint">{t("아직 알림이 없습니다")}</li>}
          </ul>
        </div>
      )}
    </div>
  );
}
