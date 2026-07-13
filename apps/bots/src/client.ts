import type { OrderSide, OrderType, OrderbookSnapshot } from "@mock-kabu/shared";

const BASE = process.env.BOT_API_URL ?? "http://localhost:4000";
const LIQUIDITY_BOOTSTRAP_TOKEN =
  process.env.LIQUIDITY_BOOTSTRAP_TOKEN ?? process.env.JWT_SECRET ?? "local-dev-secret-change-me";

export interface LiveOrder {
  id: string;
  symbol: string;
  side: OrderSide;
  type: OrderType;
  price: number | null;
  qty: number;
  filledQty: number;
  status: "OPEN" | "PARTIAL";
}

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

  /** Return the non-terminal book entries for one symbol only. */
  myLiveOrders(symbol: string, limit = 200) {
    const query = new URLSearchParams({ limit: String(limit), symbol, status: "live" });
    return this.request("GET", `/orders?${query.toString()}`) as Promise<LiveOrder[]>;
  }

  /**
   * Creates/rebalances only the clean fixed bot16..bot20 reserve accounts. It is
   * intentionally independent of a user JWT so it can run before those bot
   * accounts have logged in.
   */
  async ensureLiquidityReserves() {
    const res = await fetch(`${BASE}/internal/liquidity/ensure`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-liquidity-bootstrap-token": LIQUIDITY_BOOTSTRAP_TOKEN,
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new ApiError(res.status, `POST /internal/liquidity/ensure returned ${res.status} ${text.slice(0, 200)}`);
    }
    return res.json() as Promise<{
      reserves: { symbol: string; email: string; created: boolean; cashAdded: number; qtyAdded: number }[];
    }>;
  }

  recentTrades(symbol: string, limit = 20) {
    return this.request("GET", `/market/trades/${symbol}?limit=${limit}`) as Promise<
      { price: number; createdAt: string }[]
    >;
  }

  marketSymbols() {
    return this.request("GET", "/market/symbols") as Promise<
      { symbol: string; lastPrice: number }[]
    >;
  }

  /** Aggregated live depth used only to budget durable PARTIAL guards safely. */
  orderbook(symbol: string) {
    return this.request("GET", `/market/orderbook/${encodeURIComponent(symbol)}`) as Promise<OrderbookSnapshot>;
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
