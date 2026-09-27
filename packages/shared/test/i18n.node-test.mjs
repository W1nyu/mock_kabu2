import assert from "node:assert/strict";
import test from "node:test";
import { pickLocale } from "../dist/index.js";

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
