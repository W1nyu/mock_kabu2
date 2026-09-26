import { formatWon, LOCALE_HEADER } from "@mock-kabu/shared";
import { getLocale, serverText, translate } from "@/lib/i18n";

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4100";

const TOKEN_KEY = "mock-kabu2:token";
const USER_KEY = "mock-kabu2:user";
const SESSION_CHANGE_EVENT = "mock-kabu2:session-change";

/** 같은 탭 안에서 세션(토큰·닉네임)이 바뀔 때 알림을 받는다. 해제 함수를 돌려준다. */
export function onSessionChange(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(SESSION_CHANGE_EVENT, listener);
  return () => window.removeEventListener(SESSION_CHANGE_EVENT, listener);
}

export interface SessionUser {
  userId: string;
  accountId: string;
  nickname: string;
  isAdmin?: boolean;
}

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(TOKEN_KEY);
}

export function getUser(): SessionUser | null {
  if (typeof window === "undefined") return null;
  const raw = localStorage.getItem(USER_KEY);
  return raw ? (JSON.parse(raw) as SessionUser) : null;
}

function notifySessionChange() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(SESSION_CHANGE_EVENT));
}

export function saveSession(token: string, user: SessionUser) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
  notifySessionChange();
}

export function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  notifySessionChange();
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const LOGIN_ONLY_PREFIXES = ["/account", "/orders"];

/** 서버에서 로그인 없이는 항상 401인 경로 (공개 시세·뉴스·지수는 해당 없음). */
export function requiresLogin(path: string): boolean {
  const pathname = path.split("?")[0];
  return LOGIN_ONLY_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

export async function api<T = unknown>(
  path: string,
  options: { method?: string; body?: unknown; auth?: boolean; headers?: Record<string, string> } = {},
): Promise<T> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    // 오류 메시지·뉴스를 화면 언어로 받는다
    [LOCALE_HEADER]: getLocale(),
    ...(options.headers ?? {}),
  };
  let token: string | null = null;
  if (options.auth !== false) {
    token = getToken();
    if (token) headers.authorization = `Bearer ${token}`;
    // 로그인 전용 경로는 토큰이 없으면 서버가 어차피 401을 준다. 비로그인 방문자가 종목 화면을
    // 열어 둘 때마다 실패할 요청을 주기적으로 보내지 않도록 여기서 같은 결과로 끝낸다.
    else if (requiresLogin(path)) throw new ApiError(401, translate(getLocale(), "로그인이 필요합니다"));
  }
  const res = await fetch(`${API_URL}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (!res.ok) {
    if (res.status === 401 && token && getToken() === token) {
      clearSession();
      window.location.replace("/login");
    }
    let message = translate(getLocale(), "요청 실패 ({status})", { status: res.status });
    try {
      const body = await res.json();
      if (body.message) message = serverText(Array.isArray(body.message) ? body.message[0] : body.message);
    } catch {
      // ignore
    }
    throw new ApiError(res.status, message);
  }
  return res.json() as Promise<T>;
}

/** 주문 재시도가 두 번째 주문을 만들지 않도록 제출마다 새로 만드는 멱등 키. */
export function newIdempotencyKey(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export const fmt = new Intl.NumberFormat("ko-KR");
/** 원화 금액: 1,234원 / ₩1,234 / 1,234ウォン (화면 언어) */
export const won = (n: number | bigint) => formatWon(fmt.format(n), getLocale());
