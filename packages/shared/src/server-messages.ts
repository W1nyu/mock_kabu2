/**
 * 서버가 한국어로 만든 문장(API 오류, 예약 주문 실패 사유, 브래킷 메모 등)을 화면 언어로 옮긴다.
 *
 * 서버 코드는 그대로 한국어 문장을 던지고, 웹이 받은 문장을 이 표의 틀에 맞춰 옮긴다. 틀의 {이름}은 아무 글자와
 * 맞고, 옮긴 문장의 같은 {이름} 자리에 그대로 들어간다. 맞는 틀이 없으면 원문(한국어)을 보여 준다.
 * 새 오류 문구를 추가하면 여기에도 추가할 것 (웹 `node scripts/i18n-missing.mjs --server`로 빠진 것을 찾는다).
 */
import type { Locale } from "./i18n";

/** [한국어 틀, 영어, 일본어] */
export type ServerMessage = readonly [string, string, string];

export const SERVER_MESSAGES: readonly ServerMessage[] = [];

interface Compiled {
  regex: RegExp;
  names: string[];
  en: string;
  ja: string;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

let compiled: Compiled[] | null = null;
function compile(): Compiled[] {
  if (compiled) return compiled;
  compiled = SERVER_MESSAGES.map(([ko, en, ja]) => {
    const names: string[] = [];
    const pattern = ko
      .split(/(\{\w+\})/g)
      .map((part) => {
        const match = /^\{(\w+)\}$/.exec(part);
        if (!match) return escapeRegex(part);
        names.push(match[1]);
        return "([\\s\\S]*?)";
      })
      .join("");
    return { regex: new RegExp(`^${pattern}$`), names, en, ja };
  });
  return compiled;
}

/** 서버 문장 → 화면 언어. 한국어이거나 맞는 틀이 없으면 그대로. 끼워 넣은 값도 다시 옮겨 본다(중첩 사유). */
export function localizeServerMessage(message: string, locale: Locale, depth = 0): string {
  if (locale === "ko" || !message) return message;
  for (const entry of compile()) {
    const match = entry.regex.exec(message);
    if (!match) continue;
    const values: Record<string, string> = {};
    entry.names.forEach((name, index) => {
      const value = match[index + 1];
      values[name] = depth < 2 ? localizeServerMessage(value, locale, depth + 1) : value;
    });
    const target = locale === "en" ? entry.en : entry.ja;
    return target.replace(/\{(\w+)\}/g, (all, name: string) => values[name] ?? all);
  }
  return message;
}
