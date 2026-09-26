"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, saveSession, type SessionUser } from "@/lib/api";
import { useT } from "@/lib/i18n";

export default function LoginPage() {
  const t = useT();
  const router = useRouter();
  const [nickname, setNickname] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await api<{ token: string; user: SessionUser }>("/auth/login", {
        method: "POST",
        body: { nickname: nickname.trim(), password },
        auth: false,
      });
      saveSession(res.token, res.user);
      router.push("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : t("로그인 실패"));
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
        <h1 className="mt-5 text-2xl font-semibold tracking-tight">{t("로그인")}</h1>
        <p className="mt-1.5 text-sm text-ink-muted">{t("닉네임과 비밀번호로 계속하기")}</p>

        <form onSubmit={submit} className="mt-6 space-y-4">
          <div>
            <label className="label" htmlFor="login-nickname">
              {t("닉네임")}
            </label>
            <input
              id="login-nickname"
              className="field"
              placeholder={t("가입할 때 정한 닉네임")}
              autoComplete="username"
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
            />
          </div>
          <div>
            <label className="label" htmlFor="login-password">
              {t("비밀번호")}
            </label>
            <input
              id="login-password"
              className="field"
              placeholder="••••••••"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>

          {error && (
            <p className="rounded-control border border-up/30 bg-up/8 px-3 py-2 text-sm text-up">
              {error}
            </p>
          )}

          <button disabled={busy || !nickname.trim() || !password} className="btn btn-primary btn-block">
            {busy ? t("확인 중…") : t("로그인")}
          </button>
        </form>
      </div>

      <p className="mt-5 text-center text-sm text-ink-muted">
        {t("계정이 없나요?")}{" "}
        <Link href="/signup" className="font-medium text-sky hover:underline">
          {t("가입하고 1,000만원 받기")}
        </Link>
      </p>
    </div>
  );
}
