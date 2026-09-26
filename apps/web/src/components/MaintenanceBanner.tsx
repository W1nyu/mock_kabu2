"use client";

import { useMaintenance } from "@/lib/maintenance";
import { formatKstHm } from "@/lib/time";
import { serverText, useT } from "@/lib/i18n";

/**
 * 모든 화면 위에 뜨는 점검 안내. 운영자가 건 임시 점검은 시작 전부터 예고하고, 점검 중에는
 * 주문이 막힌다는 것을 알린다. 매일 04:10~04:20 점검은 진행 중일 때만 보인다.
 */
export default function MaintenanceBanner() {
  const status = useMaintenance();
  const t = useT();

  if (!status) return null;
  let text: string | null = null;
  if (status.active) {
    text = t("{message} ({end} 종료 예정 · 점검 중에는 주문할 수 없습니다)", {
      message: status.message ? serverText(status.message) : t("서버 점검 중입니다."),
      end: formatKstHm(Date.parse(status.endAt)),
    });
  } else if (status.upcoming) {
    const { startAt, endAt, message } = status.upcoming;
    text = t("{start}~{end} 서버 점검 예정 — {message} 점검 중에는 접속과 주문이 잠시 제한됩니다. 양해 부탁드립니다.", {
      start: formatKstHm(Date.parse(startAt)),
      end: formatKstHm(Date.parse(endAt)),
      message: serverText(message),
    });
  }
  if (!text) return null;

  return (
    <div role="status" aria-live="polite" className="border-b border-warn/40 bg-warn/12 px-4 py-2 text-center text-[13px] font-medium text-warn">
      {text}
    </div>
  );
}
