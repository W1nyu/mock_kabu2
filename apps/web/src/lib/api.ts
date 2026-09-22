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

export async function api<T = unknown>(
  path: string,
  options: { method?: string; body?: unknown; auth?: boolean; headers?: Record<string, string> } = {},
): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json", ...(options.headers ?? {}) };
  if (options.auth !== false) {
    const token = getToken();
    if (token) headers.authorization = `Bearer ${token}`;
  }
  const res = await fetch(`${API_URL}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (!res.ok) {
    let message = `요청 실패 (${res.status})`;
    try {
      const body = await res.json();
      if (body.message) message = Array.isArray(body.message) ? body.message[0] : body.message;
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
export const won = (n: number | bigint) => `${fmt.format(Number(n))}원`;
