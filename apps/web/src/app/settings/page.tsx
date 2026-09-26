"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { NICKNAME_MAX, NICKNAME_MIN, isValidNickname } from "@mock-kabu/shared";
import { api, getToken, getUser, saveSession, type SessionUser } from "@/lib/api";
import {
  canUseDesktopNotifications,
  desktopNotificationsEnabled,
  requestDesktopPermission,
  setDesktopNotificationsEnabled,
} from "@/lib/notifications";
import { useT } from "@/lib/i18n";
import LanguageSelect from "@/components/LanguageSelect";

type Notice = { ok: boolean; text: string } | null;

/**
 * 계정 설정 — 닉네임과 비밀번호. Nav 메뉴에는 넣지 않고 우상단 사용자 칩에서만 들어온다
 * (LEGACY MENU LOCK: 기본 메뉴 목록은 제품 결정 없이 늘리지 않는다).
 */
export default function SettingsPage() {
  const t = useT();
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
  const [desktopOn, setDesktopOn] = useState(false);
  const [desktopPermission, setDesktopPermission] = useState<string>("default");
  const [desktopSupported, setDesktopSupported] = useState(true);

  useEffect(() => {
    if (!getToken()) {
      router.push("/login");
      return;
    }
    const session = getUser();
    setUser(session);
    setNickname(session?.nickname ?? "");
    // 브라우저 전용 API는 마운트 후에 읽는다.
    const supported = canUseDesktopNotifications();
    setDesktopSupported(supported);
    setDesktopOn(desktopNotificationsEnabled());
    setDesktopPermission(supported ? Notification.permission : "unsupported");
  }, [router]);

  async function toggleDesktop() {
    if (desktopOn) {
      setDesktopNotificationsEnabled(false);
      setDesktopOn(false);
      return;
    }
    const permission = await requestDesktopPermission();
    setDesktopPermission(permission);
    if (permission === "granted") {
      setDesktopNotificationsEnabled(true);
      setDesktopOn(true);
    }
  }

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
      setNickNotice({ ok: true, text: t("닉네임을 변경했습니다") });
    } catch (err) {
      setNickNotice({ ok: false, text: err instanceof Error ? err.message : t("변경 실패") });
    } finally {
      setNickBusy(false);
    }
  }

  async function submitPassword(e: React.FormEvent) {
    e.preventDefault();
    if (newPassword !== confirmPassword) {
      setPwNotice({ ok: false, text: t("새 비밀번호 확인이 일치하지 않습니다") });
      return;
    }
    setPwBusy(true);
    setPwNotice(null);
    try {
      await api("/auth/password", { method: "POST", body: { currentPassword, newPassword } });
      setPwNotice({ ok: true, text: t("비밀번호를 변경했습니다") });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch (err) {
      setPwNotice({ ok: false, text: err instanceof Error ? err.message : t("변경 실패") });
    } finally {
      setPwBusy(false);
    }
  }

  const trimmed = nickname.trim();
  const nickValid = isValidNickname(trimmed) && trimmed !== user?.nickname;
  const pwValid = currentPassword.length > 0 && newPassword.length >= 4 && confirmPassword.length >= 4;

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t("계정 설정")}</h1>
        <p className="mt-1 text-sm text-ink-muted">
          {user?.nickname ?? ""} · {t("가입 보너스로 시작한 가상 계좌입니다. 닉네임이 로그인 ID입니다.")}
        </p>
      </div>

      <section className="glass overflow-hidden">
        <div className="panel-head">
          <span className="panel-title">{t("언어")}</span>
          <span className="text-[11px] text-ink-faint">{t("화면·오류 메시지·뉴스에 적용됩니다")}</span>
        </div>
        <div className="p-4 sm:max-w-xs">
          <LanguageSelect />
        </div>
      </section>

      <form onSubmit={submitNickname} className="glass overflow-hidden">
        <div className="panel-head">
          <span className="panel-title">{t("닉네임")}</span>
          <span className="text-[11px] text-ink-faint">{t("로그인 ID이자 랭킹에 표시되는 이름")}</span>
        </div>
        <div className="space-y-3 p-4">
          <div>
            <label className="label" htmlFor="settings-nickname">
              {t("닉네임 ({min}~{max}자) — 바꾸면 로그인할 때도 새 닉네임을 씁니다", { min: NICKNAME_MIN, max: NICKNAME_MAX })}
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
            {nickBusy ? t("저장 중…") : t("닉네임 저장")}
          </button>
        </div>
      </form>

      <section className="glass overflow-hidden">
        <div className="panel-head">
          <span className="panel-title">{t("브라우저 알림")}</span>
          <span className="text-[11px] text-ink-faint">{t("다른 탭에 있을 때만 시스템 알림")}</span>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 p-4">
          <p className="text-sm text-ink-muted">
            {t("체결·예약 주문 발동을 이 브라우저의 시스템 알림으로도 받습니다. 화면을 보고 있을 때는 토스트만 뜹니다.")}
            {desktopPermission === "denied" && (
              <span className="mt-1 block text-xs text-warn">
                {t("브라우저에서 알림이 차단돼 있습니다. 주소창의 사이트 설정에서 허용한 뒤 다시 켜세요.")}
              </span>
            )}
          </p>
          <button
            type="button"
            onClick={toggleDesktop}
            disabled={!desktopSupported || desktopPermission === "denied"}
            aria-pressed={desktopOn}
            className={`btn btn-sm ${desktopOn ? "btn-primary" : "btn-ghost"}`}
          >
            {!desktopSupported ? t("지원하지 않는 브라우저") : desktopOn ? t("켜짐 · 끄기") : t("켜기")}
          </button>
        </div>
      </section>

      <form onSubmit={submitPassword} className="glass overflow-hidden">
        <div className="panel-head">
          <span className="panel-title">{t("비밀번호")}</span>
        </div>
        <div className="space-y-3 p-4">
          <div>
            <label className="label" htmlFor="settings-current-password">
              {t("현재 비밀번호")}
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
                {t("새 비밀번호 (4자 이상)")}
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
                {t("새 비밀번호 확인")}
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
            {pwBusy ? t("변경 중…") : t("비밀번호 변경")}
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
