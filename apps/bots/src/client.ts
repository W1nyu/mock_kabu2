import type { OrderSide, OrderType, OrderbookSnapshot } from "@mock-kabu/shared";
import { requiredRuntimeEnv } from "./env";
import type { PressureScenario } from "./scenario";

const BASE = requiredRuntimeEnv("BOT_API_URL", "http://localhost:4100");
const LIQUIDITY_BOOTSTRAP_TOKEN = requiredRuntimeEnv(
  "LIQUIDITY_BOOTSTRAP_TOKEN",
  process.env.JWT_SECRET ?? "mock-kabu2-local-dev-secret",
);

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

export interface LiveQuoteState {
  orders: LiveOrder[];
  orderbook: OrderbookSnapshot;
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

  listConditional(status?: string) {
    const query = status ? `?status=${status}&limit=100` : "?limit=100";
    return this.request("GET", `/orders/conditional${query}`) as Promise<unknown[]>;
  }

  /** 조건부(예약) 주문. 고정 트리거는 direction+triggerPrice, 트레일링은 trailBps만 준다. */
  placeConditional(order: {
    symbol: string;
    side: OrderSide;
    qty: number;
    direction?: "AT_OR_ABOVE" | "AT_OR_BELOW";
    triggerPrice?: number;
    trailBps?: number;
  }) {
    return this.request("POST", "/orders/conditional", order) as Promise<{ id: string; status: string }>;
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
   * Creates/rebalances only the clean symbol-scoped bot16+ reserve accounts. It is
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

  /**
   * Records a generated news story so the API can persist and broadcast it.
   * Uses the same bootstrap token as the liquidity endpoint because it is the
   * same trust boundary: the local bots process talking to the local API
   * without a user session.
   */
  async publishNews(draft: {
    symbol: string | null;
    category: string;
    headline: string;
    body: string | null;
    sentiment: "POSITIVE" | "NEGATIVE";
    impact: number;
    parentExternalId: string | null;
    externalId: string;
  }) {
    const res = await fetch(`${BASE}/internal/news/publish`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-liquidity-bootstrap-token": LIQUIDITY_BOOTSTRAP_TOKEN,
      },
      body: JSON.stringify(draft),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new ApiError(
        res.status,
        `POST /internal/news/publish returned ${res.status} ${text.slice(0, 200)}`,
      );
    }
    return res.json() as Promise<{ id: string }>;
  }

  /** Admin market scenarios that are running or about to start. Same internal token as news. */
  async activeScenarios(): Promise<PressureScenario[]> {
    const res = await fetch(`${BASE}/internal/scenarios/active`, {
      headers: { "x-liquidity-bootstrap-token": LIQUIDITY_BOOTSTRAP_TOKEN },
    });
    if (!res.ok) {
      throw new ApiError(res.status, `GET /internal/scenarios/active returned ${res.status}`);
    }
    return res.json() as Promise<PressureScenario[]>;
  }

  recentTrades(symbol: string, limit = 20) {
    return this.request("GET", `/market/trades/${symbol}?limit=${limit}`) as Promise<
      { id: string; price: number; createdAt: string }[]
    >;
  }

  /** Own live rows and the public matching snapshot in one authenticated request. */
  quoteState(symbol: string) {
    const query = new URLSearchParams({ symbol });
    return this.request("GET", `/orders/quote-state?${query.toString()}`) as Promise<LiveQuoteState>;
  }

  /** Durable one-minute closes, returned in chronological order by the API. */
  marketCandles(symbol: string, limit = 120) {
    return this.request("GET", `/market/candles/${symbol}?interval=1m&limit=${limit}`) as Promise<
      { close: number; ts: string }[]
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
