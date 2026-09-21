"use client";

/**
 * 계정 알림 보관함. 토스트는 6초 뒤 사라지므로, 같은 내용을 계정별 localStorage에 최대 50건
 * 남겨 Nav의 종 아이콘에서 다시 볼 수 있게 한다. 같은 탭 안의 갱신은 커스텀 이벤트로 알린다.
 */
export interface NotificationItem {
  id: string;
  ts: number;
  tone: "up" | "down" | "info" | "warn";
  title: string;
  detail?: string;
  /** 클릭 시 이동할 경로 (예: /symbol/KABU) */
  href?: string;
}

const MAX_ITEMS = 50;
const CHANGE_EVENT = "mock-kabu2:notifications-change";

function storageKey(accountId: string): string {
  return `mock-kabu2:notifications:${accountId}`;
}

function readKey(accountId: string): string {
  return `mock-kabu2:notifications-read:${accountId}`;
}

export function listNotifications(accountId: string): NotificationItem[] {
  try {
    const raw = window.localStorage.getItem(storageKey(accountId));
    const parsed = raw ? (JSON.parse(raw) as NotificationItem[]) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function pushNotification(accountId: string, item: NotificationItem): void {
  try {
    const current = listNotifications(accountId);
    if (current.some((existing) => existing.id === item.id)) return;
    const next = [item, ...current].slice(0, MAX_ITEMS);
    window.localStorage.setItem(storageKey(accountId), JSON.stringify(next));
  } catch {
    // 저장이 막혀도(비공개 창 등) 토스트는 이미 떴다.
  }
  notifyChange();
}

/** 마지막으로 읽은 시각. 그 뒤의 알림이 "안 읽음"이다. */
export function lastReadAt(accountId: string): number {
  try {
    return Number(window.localStorage.getItem(readKey(accountId)) ?? 0) || 0;
  } catch {
    return 0;
  }
}

export function markAllRead(accountId: string): void {
  try {
    window.localStorage.setItem(readKey(accountId), String(Date.now()));
  } catch {
    // ignore
  }
  notifyChange();
}

export function clearNotifications(accountId: string): void {
  try {
    window.localStorage.removeItem(storageKey(accountId));
  } catch {
    // ignore
  }
  notifyChange();
}

function notifyChange(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function onNotificationsChange(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(CHANGE_EVENT, listener);
  return () => window.removeEventListener(CHANGE_EVENT, listener);
}
