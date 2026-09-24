"use client";

import { useEffect, useState } from "react";

export type Theme = "dark" | "light";
const STORAGE_KEY = "mock-kabu2:theme";
const CHANGE_EVENT = "mock-kabu2:theme-change";

export function currentTheme(): Theme {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

export function setTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem(STORAGE_KEY, theme); } catch { /* storage can be disabled */ }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function loadSavedTheme() {
  try { setTheme(localStorage.getItem(STORAGE_KEY) === "light" ? "light" : "dark"); }
  catch { setTheme("dark"); }
}

export function useTheme(): Theme {
  const [theme, update] = useState<Theme>("dark");
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
