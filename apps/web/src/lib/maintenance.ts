"use client";

import { useEffect, useState } from "react";
import { api } from "./api";
import { everyVisible } from "./visible-interval";

export interface MaintenanceStatus {
  active: boolean;
  /** 진행 중이면 이번 점검, 아니면 다음 정기 점검의 시각 */
  startAt: string;
  endAt: string;
  timezone?: string;
  manual?: boolean;
  message?: string | null;
  upcoming?: { startAt: string; endAt: string; message: string } | null;
}

const POLL_MS = 30_000;
/** 이보다 먼 경계는 주기 조회가 먼저 따라잡는다. */
const MAX_BOUNDARY_WAIT_MS = 60 * 60 * 1000;

/**
 * 탭 하나에 점검 상태 조회 하나. 배너와 종목 화면이 같은 값을 나눠 쓰고, 점검이 시작·끝나는
 * 시각에는 그 순간에 맞춰 다시 읽어 5초 폴링 없이도 제때 화면을 바꾼다.
 */
let current: MaintenanceStatus | null = null;
const listeners = new Set<(status: MaintenanceStatus | null) => void>();
let stopPolling: (() => void) | null = null;
let boundaryTimer: number | null = null;

function nextBoundary(status: MaintenanceStatus, now: number): number | null {
  const candidates = status.active
    ? [Date.parse(status.endAt)]
    : [Date.parse(status.startAt), status.upcoming ? Date.parse(status.upcoming.startAt) : NaN];
  const future = candidates.filter((ts) => Number.isFinite(ts) && ts > now);
  return future.length > 0 ? Math.min(...future) : null;
}

function scheduleBoundary(status: MaintenanceStatus): void {
  if (boundaryTimer !== null) window.clearTimeout(boundaryTimer);
  boundaryTimer = null;
  const now = Date.now();
  const at = nextBoundary(status, now);
  if (at === null || at - now > MAX_BOUNDARY_WAIT_MS) return;
  boundaryTimer = window.setTimeout(load, at - now + 1_000);
}

function load(): void {
  api<MaintenanceStatus>("/health/maintenance", { auth: false })
    .then((status) => {
      current = status;
      for (const listener of listeners) listener(status);
      scheduleBoundary(status);
    })
    .catch(() => {});
}

function subscribeMaintenance(listener: (status: MaintenanceStatus | null) => void): () => void {
  listeners.add(listener);
  if (!stopPolling) {
    load();
    stopPolling = everyVisible(load, POLL_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    stopPolling?.();
    stopPolling = null;
    if (boundaryTimer !== null) window.clearTimeout(boundaryTimer);
    boundaryTimer = null;
  };
}

export function useMaintenance(): MaintenanceStatus | null {
  const [status, setStatus] = useState<MaintenanceStatus | null>(current);
  useEffect(() => subscribeMaintenance(setStatus), []);
  return status;
}
