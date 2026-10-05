"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";

/**
 * 취소는 비동기다 — API가 요청을 받으면 매칭 엔진이 주문을 닫고, 그 뒤에야 미체결 목록에서 빠진다.
 * 그 사이 버튼이 그대로면 "취소가 안 된다"고 보이고, 다시 눌러도 API가 30초 안의 중복 취소를 조용히 버린다.
 * 요청이 접수된 주문은 목록에서 빠질 때까지(최대 이 시간) "취소 중"으로 보여 준다.
 */
export const CANCEL_PENDING_MS = 30_000;
/** 계좌 알림을 놓쳐도 이만큼 뒤 한 번 더 읽는다 */
const CANCEL_RECHECK_MS = 3_000;

/** 아직 목록에 있고 오래되지 않은 취소 요청만 남긴다. 바뀐 게 없으면 같은 객체를 돌려준다. */
export function prunePendingCancels(
  pending: Readonly<Record<string, number>>,
  liveIds: ReadonlySet<string> | null,
  now: number,
): Record<string, number> {
  let changed = false;
  const next: Record<string, number> = {};
  for (const [id, at] of Object.entries(pending)) {
    if (now - at >= CANCEL_PENDING_MS || (liveIds != null && !liveIds.has(id))) changed = true;
    else next[id] = at;
  }
  return changed ? next : (pending as Record<string, number>);
}

/** 미체결 목록의 취소 버튼 상태 — 요청 중/접수됨("취소 중")과 실패 사유(점검 503 등)를 보여 준다. */
export function useOrderCancel(liveIds: readonly string[], refresh: () => void) {
  const [pending, setPending] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const idsKey = liveIds.join(",");

  // 체결·취소로 목록에서 빠진 주문은 표시를 거둔다.
  useEffect(() => {
    const ids = new Set(idsKey ? idsKey.split(",") : []);
    setPending((current) => prunePendingCancels(current, ids, Date.now()));
  }, [idsKey]);

  // 30초가 지나도 남아 있으면 다시 누를 수 있게 한다(API 중복 차단도 30초).
  const hasPending = Object.keys(pending).length > 0;
  useEffect(() => {
    if (!hasPending) return;
    const timer = setInterval(() => setPending((current) => prunePendingCancels(current, null, Date.now())), 5_000);
    return () => clearInterval(timer);
  }, [hasPending]);

  const cancel = useCallback(async (id: string, fallbackError: string) => {
    setError(null);
    setPending((current) => ({ ...current, [id]: Date.now() }));
    try {
      await api(`/orders/${id}`, { method: "DELETE" });
      setTimeout(() => refreshRef.current(), CANCEL_RECHECK_MS);
    } catch (err) {
      setPending((current) => {
        const { [id]: _removed, ...rest } = current;
        return rest;
      });
      // 점검 중(503)이면 그 안내가, 이미 체결됐으면 "이미 종결된 주문"이 그대로 보인다.
      setError(err instanceof Error && err.message ? err.message : fallbackError);
    } finally {
      refreshRef.current();
    }
  }, []);

  return { pending, error, setError, cancel };
}
