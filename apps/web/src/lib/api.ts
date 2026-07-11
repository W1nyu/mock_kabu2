export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export interface SessionUser {
  userId: string;
  accountId: string;
  email: string;
  nickname: string;
}

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("mk_token");
}

export function getUser(): SessionUser | null {
  if (typeof window === "undefined") return null;
  const raw = localStorage.getItem("mk_user");
  return raw ? (JSON.parse(raw) as SessionUser) : null;
}

export function saveSession(token: string, user: SessionUser) {
  localStorage.setItem("mk_token", token);
  localStorage.setItem("mk_user", JSON.stringify(user));
}

export function clearSession() {
  localStorage.removeItem("mk_token");
  localStorage.removeItem("mk_user");
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
  options: { method?: string; body?: unknown; auth?: boolean } = {},
): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json" };
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

export const fmt = new Intl.NumberFormat("ko-KR");
export const won = (n: number | bigint) => `${fmt.format(Number(n))}원`;
