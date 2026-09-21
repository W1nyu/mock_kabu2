"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api, getToken, getUser, saveSession, type SessionUser } from "@/lib/api";

type Notice = { ok: boolean; text: string } | null;

/**
 * 계정 설정 — 닉네임과 비밀번호. Nav 메뉴에는 넣지 않고 우상단 사용자 칩에서만 들어온다
 * (LEGACY MENU LOCK: 기본 메뉴 목록은 제품 결정 없이 늘리지 않는다).
 */
export default function SettingsPage() {
  const router = useRouter();
  const [user, setUser] = useState<SessionUser | null>(null);
  const [nickname, setNickname] = useState("");
  const [nickNotice, setNickNotice] = useState<Notice>(null);
  const [nickBusy, setNickBusy] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [pwNotice, setPwNotice] = useState<Notice>(null);
  const [pwBusy, setPwBusy] = useState(false);

  useEffect(() => {
    if (!getToken()) {
      router.push("/login");
      return;
    }
    const session = getUser();
    setUser(session);
    setNickname(session?.nickname ?? "");
  }, [router]);

  async function submitNickname(e: React.FormEvent) {
    e.preventDefault();
    setNickBusy(true);
    setNickNotice(null);
    try {
      const result = await api<{ token: string; user: SessionUser }>("/auth/me", {
        method: "PATCH",
        body: { nickname },
      });
      // 닉네임은 토큰 안에도 들어 있으므로 새 토큰으로 세션을 통째로 갈아 끼운다.
      saveSession(result.token, result.user);
      setUser(result.user);
      setNickNotice({ ok: true, text: "닉네임을 변경했습니다" });
    } catch (err) {
      setNickNotice({ ok: false, text: err instanceof Error ? err.message : "변경 실패" });
    } finally {
      setNickBusy(false);
    }
  }

  async function submitPassword(e: React.FormEvent) {
    e.preventDefault();
    if (newPassword !== confirmPassword) {
      setPwNotice({ ok: false, text: "새 비밀번호 확인이 일치하지 않습니다" });
      return;
    }
    setPwBusy(true);
    setPwNotice(null);
    try {
      await api("/auth/password", { method: "POST", body: { currentPassword, newPassword } });
      setPwNotice({ ok: true, text: "비밀번호를 변경했습니다" });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch (err) {
      setPwNotice({ ok: false, text: err instanceof Error ? err.message : "변경 실패" });
    } finally {
      setPwBusy(false);
    }
  }

  const trimmed = nickname.trim();
  const nickValid = trimmed.length >= 1 && trimmed.length <= 20 && trimmed !== user?.nickname;
  const pwValid = currentPassword.length > 0 && newPassword.length >= 4 && confirmPassword.length >= 4;

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">계정 설정</h1>
        <p className="mt-1 text-sm text-ink-muted">
          {user?.email ?? ""} · 가입 보너스로 시작한 가상 계좌입니다. 이메일은 바꿀 수 없습니다.
        </p>
      </div>

      <form onSubmit={submitNickname} className="glass overflow-hidden">
        <div className="panel-head">
          <span className="panel-title">닉네임</span>
          <span className="text-[11px] text-ink-faint">투자자 랭킹에 표시됩니다</span>
        </div>
        <div className="space-y-3 p-4">
          <div>
            <label className="label" htmlFor="settings-nickname">
              닉네임 (1~20자)
            </label>
            <input
              id="settings-nickname"
              className="field"
              value={nickname}
              maxLength={20}
              onChange={(e) => setNickname(e.target.value)}
            />
          </div>
          <Notice notice={nickNotice} />
          <button disabled={nickBusy || !nickValid} className="btn btn-primary btn-sm">
            {nickBusy ? "저장 중…" : "닉네임 저장"}
          </button>
        </div>
      </form>

      <form onSubmit={submitPassword} className="glass overflow-hidden">
        <div className="panel-head">
          <span className="panel-title">비밀번호</span>
        </div>
        <div className="space-y-3 p-4">
          <div>
            <label className="label" htmlFor="settings-current-password">
              현재 비밀번호
            </label>
            <input
              id="settings-current-password"
              type="password"
              autoComplete="current-password"
              className="field"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="settings-new-password">
                새 비밀번호 (4자 이상)
              </label>
              <input
                id="settings-new-password"
                type="password"
                autoComplete="new-password"
                className="field"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
              />
            </div>
            <div>
              <label className="label" htmlFor="settings-confirm-password">
                새 비밀번호 확인
              </label>
              <input
                id="settings-confirm-password"
                type="password"
                autoComplete="new-password"
                className="field"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
              />
            </div>
          </div>
          <Notice notice={pwNotice} />
          <button disabled={pwBusy || !pwValid} className="btn btn-primary btn-sm">
            {pwBusy ? "변경 중…" : "비밀번호 변경"}
          </button>
        </div>
      </form>
    </div>
  );
}

function Notice({ notice }: { notice: Notice }) {
  if (!notice) return null;
  return (
    <p
      className={`rounded-control border px-3 py-2 text-sm ${
        notice.ok ? "border-ok/30 bg-ok/8 text-ok" : "border-up/30 bg-up/8 text-up"
      }`}
    >
      {notice.text}
    </p>
  );
}
