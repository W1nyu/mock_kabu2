#!/usr/bin/env node
/**
 * 화면 문구 중 영어·일본어 사전에 없는 키를 찾는다.
 *   node scripts/i18n-missing.mjs          # 빠진 키 목록(없으면 exit 0)
 *   node scripts/i18n-missing.mjs --json   # {en:[...], ja:[...]} (번역 작업용)
 *   node scripts/i18n-missing.mjs --unused # 사전에만 있고 코드에서 안 쓰는 키
 * 키는 t("…")·translate(locale, "…")의 첫 인자(큰따옴표 문자열)다.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = new URL("../src/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(tsx?|mjs)$/.test(name) && !path.includes(`${join("lib", "i18n")}`)) out.push(path);
  }
  return out;
}

const unescape = (s) => JSON.parse(`"${s}"`);
const used = new Map();
const CALL = /\b(?:t|translate\(\s*[\w.]+\s*,)\s*\(?\s*"((?:[^"\\]|\\.)*)"/g;
for (const file of walk(root)) {
  const text = readFileSync(file, "utf8");
  for (const match of text.matchAll(/\b(?:t|tr)\(\s*"((?:[^"\\]|\\.)*)"/g)) used.set(unescape(match[1]), file);
  for (const match of text.matchAll(/\btranslate\(\s*[\w.()]+\s*,\s*"((?:[^"\\]|\\.)*)"/g)) used.set(unescape(match[1]), file);
}
void CALL;

function dictKeys() {
  const text = readFileSync(join(root, "lib", "i18n", "messages.ts"), "utf8");
  const keys = new Set();
  for (const match of text.matchAll(/^\s*"((?:[^"\\]|\\.)*)"\s*:\s*\[/gm)) keys.add(unescape(match[1]));
  return keys;
}

const keys = dictKeys();
const dicts = { en: keys, ja: keys };
const args = process.argv.slice(2);
if (args.includes("--unused")) {
  for (const [name, keys] of Object.entries(dicts)) {
    const unused = [...keys].filter((key) => !used.has(key));
    console.log(`${name}: ${unused.length} unused`);
    for (const key of unused) console.log(`  ${JSON.stringify(key)}`);
  }
  process.exit(0);
}
const missing = Object.fromEntries(Object.entries(dicts).map(([name, keys]) => [name, [...used.keys()].filter((key) => !keys.has(key))]));
if (args.includes("--json")) {
  console.log(JSON.stringify(missing, null, 2));
} else {
  for (const [name, keys] of Object.entries(missing)) {
    console.log(`${name}: ${keys.length} missing`);
    for (const key of keys.slice(0, 50)) console.log(`  ${JSON.stringify(key)}  (${used.get(key).slice(root.length)})`);
  }
}
process.exit(Object.values(missing).some((keys) => keys.length > 0) ? 1 : 0);
