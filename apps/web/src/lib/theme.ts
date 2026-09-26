"use client";

import { useEffect, useState } from "react";

export type Theme = "dark" | "light";
/** 처음 오는 사람은 라이트. 사용자가 직접 고른 테마만 저장한다. */
export const DEFAULT_THEME: Theme = "light";
export const STORAGE_KEY = "mock-kabu2:theme";
const CHANGE_EVENT = "mock-kabu2:theme-change";

export function currentTheme(): Theme {
  if (typeof document === "undefined") return DEFAULT_THEME;
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

export function setTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem(STORAGE_KEY, theme); } catch { /* storage can be disabled */ }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

/** 저장된 테마를 적용한다(없으면 기본 라이트). 저장은 하지 않는다 — 기본값이 사용자 선택처럼 굳지 않게. */
export function loadSavedTheme() {
  let saved: string | null = null;
  try { saved = localStorage.getItem(STORAGE_KEY); } catch { /* storage can be disabled */ }
  document.documentElement.dataset.theme = saved === "dark" || saved === "light" ? saved : DEFAULT_THEME;
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function useTheme(): Theme {
  const [theme, update] = useState<Theme>(DEFAULT_THEME);
  useEffect(() => {
    const refresh = () => update(currentTheme());
    refresh();
    window.addEventListener(CHANGE_EVENT, refresh);
    return () => window.removeEventListener(CHANGE_EVENT, refresh);
  }, []);
  return theme;
}

export function chartTheme() {
  const css = getComputedStyle(document.documentElement);
  return {
    text: css.getPropertyValue("--color-ink-muted").trim(),
    grid: css.getPropertyValue("--chart-grid").trim(),
    border: css.getPropertyValue("--chart-border").trim(),
    up: css.getPropertyValue("--color-up").trim(),
    down: css.getPropertyValue("--color-down").trim(),
    sky: css.getPropertyValue("--color-sky").trim(),
  };
}
