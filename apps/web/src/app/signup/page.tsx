"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, saveSession, type SessionUser } from "@/lib/api";

export default function SignupPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [nickname, setNickname] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await api<{ token: string; user: SessionUser }>("/auth/signup", {
        method: "POST",
        body: { email, password, nickname },
        auth: false,
      });
      saveSession(res.token, res.user);
      router.push("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "가입 실패");
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
        <h1 className="mt-5 text-2xl font-semibold tracking-tight">회원가입</h1>
        <p className="mt-1.5 text-sm text-ink-muted">
          가입 즉시 가상 현금{" "}
          <span className="num font-semibold text-sky">1,000만원</span>이 지급됩니다.
        </p>

        <form onSubmit={submit} className="mt-6 space-y-4">
          <div>
            <label className="label" htmlFor="signup-email">
              이메일
            </label>
            <input
              id="signup-email"
              className="field"
              placeholder="you@example.com"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div>
            <label className="label" htmlFor="signup-nickname">
              닉네임
            </label>
            <input
              id="signup-nickname"
              className="field"
              placeholder="표시될 이름"
              autoComplete="nickname"
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
            />
          </div>
          <div>
            <label className="label" htmlFor="signup-password">
              비밀번호
            </label>
            <input
              id="signup-password"
              className="field"
              placeholder="4자 이상"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>

          {error && (
            <p className="rounded-control border border-up/30 bg-up/8 px-3 py-2 text-sm text-up">
              {error}
            </p>
          )}

          <button disabled={busy} className="btn btn-primary btn-block">
            {busy ? "가입 중…" : "가입하기"}
          </button>
        </form>
      </div>

      <p className="mt-5 text-center text-sm text-ink-muted">
        이미 계정이 있나요?{" "}
        <Link href="/login" className="font-medium text-sky hover:underline">
          로그인
        </Link>
      </p>
    </div>
  );
}
