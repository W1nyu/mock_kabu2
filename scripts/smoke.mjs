#!/usr/bin/env node
/**
 * 실행 중인 스택(API :4100)에 대한 E2E 스모크. 임시 사용자를 만들어 주문 → 체결 → 실현손익 →
 * 조건부/OCO/트레일링/브래킷 → 자산·성과·랭킹 엔드포인트를 한 번씩 밟는다.
 *
 *   pnpm smoke                      # 기본 http://localhost:4100
 *   API_URL=http://host:4100 pnpm smoke
 *
 * 봇이 상시 거래하므로 시장가는 수 초 안에 체결된다. 실패하면 exit 1.
 */
const API = process.env.API_URL ?? "http://localhost:4100";
let failures = 0;
let token = null;

function check(name, ok, detail) {
  if (ok) console.log(`PASS  ${name}`);
  else {
    failures += 1;
    console.error(`FAIL  ${name}`, detail ?? "");
  }
}

async function call(method, path, body, { auth = true, expectStatus } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(auth && token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  if (expectStatus != null && res.status !== expectStatus) {
    throw new Error(`${method} ${path} → ${res.status} (expected ${expectStatus}): ${text.slice(0, 200)}`);
  }
  if (expectStatus == null && !res.ok) {
    throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 200)}`);
  }
  return json;
}

async function callWithHeaders(method, path, body, extraHeaders) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...extraHeaders },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(name, probe, { timeoutMs = 15_000, intervalMs = 500 } = {}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = await probe();
    if (value) return value;
    await sleep(intervalMs);
  }
  throw new Error(`timeout waiting for ${name}`);
}

async function main() {
  const health = await call("GET", "/health/trading", null, { auth: false });
  check("trading readiness ok", health.status === "ok", health);

  const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
  const nickname = `smoke-${suffix}`;
  const signup = await call("POST", "/auth/signup", { nickname, password: "smokepass123" }, { auth: false });
  token = signup.token;
  check("signup issues a token", typeof token === "string" && token.length > 20);
  const login = await call("POST", "/auth/login", { nickname, password: "smokepass123" }, { auth: false });
  check("login by nickname works", login.user?.nickname === nickname, login.user);

  const symbols = await call("GET", "/market/symbols", null, { auth: false });
  const symbol = symbols.find((s) => s.symbol === "TANU")?.symbol ?? symbols[0].symbol;
  const tick = 10;

  // 1) 시장가 매수 → 체결 → 보유
  const buy = await call("POST", "/orders", { symbol, side: "BUY", type: "MARKET", qty: 20 });
  await waitFor("buy fill", async () => {
    const rows = await call("GET", `/orders?symbol=${symbol}&limit=5`);
    return rows.find((o) => o.id === buy.id && o.status === "FILLED");
  });
  const holdings = await call("GET", "/account/holdings");
  const holding = holdings.find((h) => h.symbol === symbol);
  check("holding reflects the fill", holding?.qty === 20 && holding.avgCost > 0, holding);

  // 2) 호가 단위 위반은 400
  await call("POST", "/orders", { symbol, side: "BUY", type: "LIMIT", price: holding.lastPrice + 5, qty: 1 }, { expectStatus: 400 });
  check("off-tick limit price is rejected", true);

  // 2b) 멱등 키: 같은 키의 재시도는 같은 주문을 돌려준다
  const idemKey = `smoke-${suffix}-idem`;
  const idemHeaders = { "idempotency-key": idemKey };
  const first = await callWithHeaders("POST", "/orders", { symbol, side: "BUY", type: "LIMIT", price: Math.max(tick, Math.floor(holding.lastPrice / 2 / tick) * tick), qty: 1 }, idemHeaders);
  const replay = await callWithHeaders("POST", "/orders", { symbol, side: "BUY", type: "LIMIT", price: Math.max(tick, Math.floor(holding.lastPrice / 2 / tick) * tick), qty: 1 }, idemHeaders);
  check("idempotency key replays the same order", first.id === replay.id && replay.idempotentReplay === true, { first: first.id, replay: replay.id });
  await call("DELETE", `/orders/${first.id}`);

  // 3) 시장가 매도 5주 → 실현손익 행
  await call("POST", "/orders", { symbol, side: "SELL", type: "MARKET", qty: 5 });
  const realized = await waitFor("realized row", async () => {
    const r = await call("GET", "/account/realized?limit=5");
    return r.totalQty >= 5 ? r : null;
  });
  check("realized pnl recorded for the sale", realized.recent.length >= 1 && realized.stats.fills >= 1, realized.stats);
  const trades = await call("GET", `/account/trades?symbol=${symbol}&limit=5`);
  check("my trades include a sell with realized", trades.some((t) => t.side === "SELL" && t.realized != null), trades[0]);

  // 4) 이미 만족하는 조건은 400, 먼 조건은 WAITING → 취소
  const last = (await call("GET", "/market/symbols", null, { auth: false })).find((s) => s.symbol === symbol).lastPrice;
  await call("POST", "/orders/conditional", { symbol, side: "SELL", direction: "AT_OR_BELOW", triggerPrice: last + tick * 10, qty: 1 }, { expectStatus: 400 });
  check("already-met condition is rejected", true);
  const far = await call("POST", "/orders/conditional", { symbol, side: "SELL", direction: "AT_OR_BELOW", triggerPrice: Math.max(tick, Math.floor(last / 2 / tick) * tick), qty: 1 });
  check("far stop waits", far.status === "WAITING", far);
  const canceled = await call("DELETE", `/orders/conditional/${far.id}`);
  check("waiting stop can be canceled", canceled.status === "CANCELED", canceled);

  // 5) OCO 한 쌍 → 한 다리 취소 시 짝도 취소
  const oco = await call("POST", "/orders/conditional/oco", { symbol, side: "SELL", qty: 2, lowerPrice: Math.max(tick, last - tick * 50), upperPrice: last + tick * 50 });
  check("oco creates two legs in one group", oco.length === 2 && oco[0].ocoGroupId === oco[1].ocoGroupId, oco);
  await call("DELETE", `/orders/conditional/${oco[0].id}`);
  const after = await call("GET", `/orders/conditional?symbol=${symbol}&limit=10`);
  const sibling = after.find((r) => r.id === oco[1].id);
  check("canceling one oco leg cancels its sibling", sibling?.status === "CANCELED", sibling);

  // 6) 트레일링: 트리거가 현재가 아래에서 시작
  const trail = await call("POST", "/orders/conditional", { symbol, side: "SELL", qty: 1, trailBps: 300 });
  check("trailing stop starts below the watermark", trail.trailBps === 300 && trail.triggerPrice < trail.watermark, trail);
  await call("DELETE", `/orders/conditional/${trail.id}`);

  // 7) 브래킷: 체결 후 OCO 자동 등록
  const bracketBuy = await call("POST", "/orders", { symbol, side: "BUY", type: "MARKET", qty: 3, bracket: { stopBps: 500, takeBps: 1000 } });
  check("bracket intent attached to the buy", bracketBuy.bracket?.status === "PENDING", bracketBuy.bracket);
  const armed = await waitFor(
    "bracket armed",
    async () => {
      const intents = await call("GET", `/orders/bracket?symbol=${symbol}&limit=5`);
      const row = intents.find((i) => i.id === bracketBuy.bracket.id);
      return row && row.status !== "PENDING" ? row : null;
    },
    { timeoutMs: 25_000, intervalMs: 1_000 },
  );
  check("bracket armed after the fill", armed.status === "ARMED" && armed.armedQty === 3, armed);
  const waiting = await call("GET", `/orders/conditional?symbol=${symbol}&status=WAITING&limit=20`);
  for (const row of waiting) await call("DELETE", `/orders/conditional/${row.id}`).catch(() => {});

  // 8) 대시보드 엔드포인트
  const equity = await call("GET", "/account/equity?range=1d");
  check("equity endpoint answers", Array.isArray(equity));
  const daily = await call("GET", "/account/daily?days=3");
  check("daily endpoint answers", Array.isArray(daily));
  const board = await call("GET", "/account/leaderboard?limit=5");
  // 스모크 계정(@smoke.local)은 순위에서 제외되므로 내 행이 없어야 정상이다.
  check("leaderboard answers and hides smoke accounts", Array.isArray(board.rows) && !board.rows.some((r) => r.me), board.rows.length);
  const ready = await call("GET", "/health/ready", null, { auth: false });
  check("health lists background jobs", ready.background?.conditionalOrders?.status === "up" && ready.background?.bracketIntents?.status === "up", ready.background);

  // 정리: 남은 보유 청산
  const rest = (await call("GET", "/account/holdings")).find((h) => h.symbol === symbol);
  if (rest?.availableQty > 0) await call("POST", "/orders", { symbol, side: "SELL", type: "MARKET", qty: rest.availableQty });

  if (failures > 0) {
    console.error(`\n스모크 실패: ${failures}건`);
    process.exit(1);
  }
  console.log(`\n스모크 전부 통과 (${nickname})`);
}

main().catch((error) => {
  console.error("FAIL ", error.message ?? error);
  process.exit(1);
});
