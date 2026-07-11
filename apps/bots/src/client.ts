import type { OrderSide, OrderType } from "@mock-kabu/shared";

const BASE = process.env.BOT_API_URL ?? "http://localhost:4000";

export class ApiClient {
  private token = "";

  constructor(readonly email: string) {}

  async login(password: string): Promise<void> {
    const res = await fetch(`${BASE}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: this.email, password }),
    });
    if (!res.ok) throw new Error(`login failed for ${this.email}: ${res.status}`);
    const body = (await res.json()) as { token: string };
    this.token = body.token;
  }

  private async request(method: string, path: string, body?: unknown) {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.token}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new ApiError(res.status, `${method} ${path} → ${res.status} ${text.slice(0, 200)}`);
    }
    return res.json();
  }

  placeOrder(order: { symbol: string; side: OrderSide; type: OrderType; price?: number; qty: number }) {
    return this.request("POST", "/orders", order) as Promise<{ id: string }>;
  }

  cancelOrder(orderId: string) {
    return this.request("DELETE", `/orders/${orderId}`);
  }

  myOrders(limit = 100) {
    return this.request("GET", `/orders?limit=${limit}`) as Promise<
      { id: string; symbol: string; status: string }[]
    >;
  }

  recentTrades(symbol: string, limit = 20) {
    return this.request("GET", `/market/trades/${symbol}?limit=${limit}`) as Promise<
      { price: number; createdAt: string }[]
    >;
  }
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** 사업 규칙 거절(잔액 부족 등)은 봇에겐 정상 상황 — 조용히 무시 */
export function isRejection(e: unknown): boolean {
  return e instanceof ApiError && [400, 404, 409, 422].includes(e.status);
}
