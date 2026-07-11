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
    <div className="mx-auto mt-16 max-w-sm rounded-lg border border-neutral-800 bg-neutral-900 p-6">
      <h1 className="mb-1 text-xl font-bold">회원가입</h1>
      <p className="mb-4 text-sm text-neutral-400">가입 즉시 가상 현금 1,000만원이 지급됩니다.</p>
      <form onSubmit={submit} className="space-y-3">
        <input
          className="w-full rounded border border-neutral-700 bg-neutral-950 px-3 py-2"
          placeholder="이메일"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <input
          className="w-full rounded border border-neutral-700 bg-neutral-950 px-3 py-2"
          placeholder="닉네임"
          value={nickname}
          onChange={(e) => setNickname(e.target.value)}
        />
        <input
          className="w-full rounded border border-neutral-700 bg-neutral-950 px-3 py-2"
          placeholder="비밀번호 (4자 이상)"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && <p className="text-sm text-red-400">{error}</p>}
        <button
          disabled={busy}
          className="w-full rounded bg-amber-500 py-2 font-semibold text-neutral-950 hover:bg-amber-400 disabled:opacity-50"
        >
          가입하기
        </button>
      </form>
      <p className="mt-4 text-sm text-neutral-400">
        이미 계정이 있나요?{" "}
        <Link href="/login" className="text-amber-400 hover:underline">
          로그인
        </Link>
      </p>
    </div>
  );
}
