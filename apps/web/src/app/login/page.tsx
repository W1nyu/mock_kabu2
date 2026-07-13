"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, saveSession, type SessionUser } from "@/lib/api";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
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
        body: { email, password },
        auth: false,
      });
      saveSession(res.token, res.user);
      router.push("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "로그인 실패");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto mt-16 max-w-sm rounded-lg border border-neutral-800 bg-neutral-900 p-6">
      <h1 className="mb-4 text-xl font-bold">로그인</h1>
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
          placeholder="비밀번호"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && <p className="text-sm text-red-400">{error}</p>}
        <button
          disabled={busy}
          className="w-full rounded bg-amber-500 py-2 font-semibold text-neutral-950 hover:bg-amber-400 disabled:opacity-50"
        >
          로그인
        </button>
      </form>
      <p className="mt-4 text-sm text-neutral-400">
        계정이 없나요?{" "}
        <Link href="/signup" className="text-amber-400 hover:underline">
          가입하고 1,000만원 받기
        </Link>
      </p>
    </div>
  );
}
