"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { NICKNAME_MAX, NICKNAME_MIN, isValidNickname, normalizeNickname } from "@mock-kabu/shared";
import { api, saveSession, type SessionUser } from "@/lib/api";
import { rich, useT } from "@/lib/i18n";

export default function SignupPage() {
  const t = useT();
  const router = useRouter();
  const [nickname, setNickname] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const name = normalizeNickname(nickname);
  const nickValid = isValidNickname(name);
  const pwValid = password.length >= 4;
  const confirmValid = confirm === password;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!nickValid || !pwValid || !confirmValid) return;
    setBusy(true);
    setError("");
    try {
      const res = await api<{ token: string; user: SessionUser }>("/auth/signup", {
        method: "POST",
        body: { nickname: name, password },
        auth: false,
      });
      saveSession(res.token, res.user);
      router.push("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : t("가입 실패"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto mt-10 w-full max-w-[26rem] sm:mt-20">
      <div className="glass p-7 sm:p-8">
        <span className="grid h-11 w-11 place-items-center rounded-xl bg-linear-to-br from-sky to-indigo shadow-glow">
          <span className="h-3.5 w-3.5 rounded-[4px] bg-abyss" />
        </span>
        <h1 className="mt-5 text-2xl font-semibold tracking-tight">{t("회원가입")}</h1>
        <p className="mt-1.5 text-sm text-ink-muted">
          {rich(t("이메일 없이 닉네임과 비밀번호만으로 시작합니다. 가입 즉시 가상 현금 {bonus}이 지급됩니다."), {
            bonus: <span className="num font-semibold text-sky">{t("1,000만원")}</span>,
          })}
        </p>

        <form onSubmit={submit} className="mt-6 space-y-4">
          <div>
            <label className="label" htmlFor="signup-nickname">
              {t("닉네임 ({min}~{max}자)", { min: NICKNAME_MIN, max: NICKNAME_MAX })}
            </label>
            <input
              id="signup-nickname"
              className="field"
              placeholder={t("로그인에 쓰는 이름")}
              autoComplete="username"
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
            />
            {name.length > 0 && !nickValid && (
              <p className="mt-1 text-xs text-ink-faint">{t("한글·영문·숫자·_ - . 만 쓸 수 있습니다")}</p>
            )}
          </div>
          <div>
            <label className="label" htmlFor="signup-password">
              {t("비밀번호")}
            </label>
            <input
              id="signup-password"
              className="field"
              placeholder={t("4자 이상")}
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <div>
            <label className="label" htmlFor="signup-confirm">
              {t("비밀번호 확인")}
            </label>
            <input
              id="signup-confirm"
              className="field"
              placeholder={t("다시 입력")}
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
            {confirm.length > 0 && !confirmValid && (
              <p className="mt-1 text-xs text-up">{t("비밀번호가 일치하지 않습니다")}</p>
            )}
          </div>

          {error && (
            <p className="rounded-control border border-up/30 bg-up/8 px-3 py-2 text-sm text-up">
              {error}
            </p>
          )}

          <button disabled={busy || !nickValid || !pwValid || !confirmValid} className="btn btn-primary btn-block">
            {busy ? t("가입 중…") : t("가입하기")}
          </button>
        </form>
      </div>

      <p className="mt-5 text-center text-sm text-ink-muted">
        {t("이미 계정이 있나요?")}{" "}
        <Link href="/login" className="font-medium text-sky hover:underline">
          {t("로그인")}
        </Link>
      </p>
    </div>
  );
}
