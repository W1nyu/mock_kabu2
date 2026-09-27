import assert from "node:assert/strict";
import test from "node:test";
import { formatWon, localizeServerMessage, pickLocale } from "../dist/index.js";

test("pickLocale matches Korean and Japanese browsers", () => {
  assert.equal(pickLocale("ko-KR,ko;q=0.9,en-US;q=0.8"), "ko");
  assert.equal(pickLocale("ja-JP,ja;q=0.9"), "ja");
  assert.equal(pickLocale("en-US,en;q=0.9"), "en");
  assert.equal(pickLocale("fr-FR,ja;q=0.5"), "ja");
});

test("pickLocale falls back to English", () => {
  assert.equal(pickLocale("fr-FR,fr;q=0.9"), "en");
  assert.equal(pickLocale("zh-CN"), "en");
  assert.equal(pickLocale(""), "en");
  assert.equal(pickLocale(null), "en");
  assert.equal(pickLocale(undefined), "en");
});

test("원화 금액: 일본어도 영어처럼 ₩ 표기(ウォン 쓰지 않음)", () => {
  assert.equal(formatWon("1,234", "ko"), "1,234원");
  assert.equal(formatWon("1,234", "en"), "₩1,234");
  assert.equal(formatWon("1,234", "ja"), "₩1,234");
  assert.equal(formatWon("-5,000", "ja"), "-₩5,000");
  assert.equal(localizeServerMessage("지정가는 1,000,000원까지입니다", "ja"), "指値は₩1,000,000までです");
});
