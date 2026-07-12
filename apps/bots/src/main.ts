import "./env";
import { SYMBOLS, type SymbolDef } from "@mock-kabu/shared";
import { ApiClient, isRejection } from "./client";

const BOT_PASSWORD = "botpassword";

const rand = (min: number, max: number) => min + Math.random() * (max - min);
const randInt = (min: number, max: number) => Math.floor(rand(min, max + 1));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 표준정규 난수 (Box-Muller) */
function gaussian(): number {
  const u = Math.random() || 1e-9;
  const v = Math.random() || 1e-9;
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** 심볼별 기준가 — GBM 랜덤워크 (스펙 미결정 사항의 확정안) */
class ReferencePrice {
  private prices = new Map<string, number>();

  constructor(symbols: SymbolDef[]) {
    for (const s of symbols) this.prices.set(s.symbol, s.initialPrice);
  }

  /** 1틱 진행: dS = S(μdt + σ√dt·Z), 틱당 σ=0.2% */
  tick() {
    for (const [symbol, price] of this.prices) {
      const sigma = 0.002;
      const drift = -0.5 * sigma * sigma;
      const next = price * Math.exp(drift + sigma * gaussian());
      this.prices.set(symbol, Math.max(1, next));
    }
  }

  get(symbol: string): number {
    return this.prices.get(symbol)!;
  }
}

/** tickSize에 맞춰 가격 정렬 */
function toTick(price: number, def: SymbolDef): number {
  return Math.max(def.tickSize, Math.round(price / def.tickSize) * def.tickSize);
}

/** 마켓메이커: 기준가 ± 스프레드로 양측 지정가 3레벨을 항상 유지 */
async function runMarketMaker(client: ApiClient, def: SymbolDef, ref: ReferencePrice) {
  let openIds: string[] = [];
  while (true) {
    try {
      // 이전 호가 취소 → 재호가
      for (const id of openIds) {
        await client.cancelOrder(id).catch((e) => {
          if (!isRejection(e)) throw e;
        });
      }
      openIds = [];

      const mid = ref.get(def.symbol);
      for (let level = 1; level <= 3; level++) {
        const spread = 0.0015 * level;
        const bid = toTick(mid * (1 - spread), def);
        const ask = toTick(mid * (1 + spread), def);
        if (bid >= ask) continue;
        const qty = randInt(5, 25);
        const [b, a] = await Promise.all([
          client.placeOrder({ symbol: def.symbol, side: "BUY", type: "LIMIT", price: bid, qty }).catch((e) => {
            if (isRejection(e)) return null;
            throw e;
          }),
          client.placeOrder({ symbol: def.symbol, side: "SELL", type: "LIMIT", price: ask, qty }).catch((e) => {
            if (isRejection(e)) return null;
            throw e;
          }),
        ]);
        if (b) openIds.push(b.id);
        if (a) openIds.push(a.id);
      }
    } catch (e) {
      console.error(`[mm:${def.symbol}]`, e instanceof Error ? e.message : e);
    }
    await sleep(rand(1200, 2000));
  }
}

/** 소액 개미 투자자: 1~5주 소량, 추세 추종 성향 (오르면 사고 내리면 파는 경향) */
async function runRetailTrader(client: ApiClient, ref: ReferencePrice, name: string) {
  while (true) {
    try {
      const def = SYMBOLS[randInt(0, SYMBOLS.length - 1)];
      // 최근 체결 흐름을 보고 65% 확률로 추세를 따라간다
      let side: "BUY" | "SELL" = Math.random() < 0.5 ? "BUY" : "SELL";
      const trades = await client.recentTrades(def.symbol, 6);
      if (trades.length >= 3) {
        const up = trades[0].price >= trades[trades.length - 1].price;
        side = Math.random() < 0.65 ? (up ? "BUY" : "SELL") : up ? "SELL" : "BUY";
      }
      const qty = randInt(1, 5);
      if (Math.random() < 0.5) {
        await client.placeOrder({ symbol: def.symbol, side, type: "MARKET", qty });
      } else {
        const drift = side === "BUY" ? rand(0.997, 1.001) : rand(0.999, 1.003);
        const price = toTick(ref.get(def.symbol) * drift, def);
        await client.placeOrder({ symbol: def.symbol, side, type: "LIMIT", price, qty });
      }
    } catch (e) {
      if (!isRejection(e)) console.error(`[retail:${name}]`, e instanceof Error ? e.message : e);
    }
    await sleep(rand(1000, 3500));
  }
}

/** 고래: 낮은 빈도로 대량 주문 — 가격에 충격을 주고 추세를 만든다 */
async function runWhale(client: ApiClient, ref: ReferencePrice, name: string) {
  while (true) {
    await sleep(rand(15_000, 45_000));
    try {
      const def = SYMBOLS[randInt(0, SYMBOLS.length - 1)];
      const side = Math.random() < 0.5 ? "BUY" : "SELL";
      const qty = randInt(100, 400);
      if (Math.random() < 0.5) {
        await client.placeOrder({ symbol: def.symbol, side, type: "MARKET", qty });
      } else {
        // 호가를 몇 단계 관통하는 공격적 지정가
        const drift = side === "BUY" ? 1.004 : 0.996;
        const price = toTick(ref.get(def.symbol) * drift, def);
        await client.placeOrder({ symbol: def.symbol, side, type: "LIMIT", price, qty });
      }
      console.log(`[whale:${name}] ${def.symbol} ${side} ${qty}주`);
    } catch (e) {
      if (!isRejection(e)) console.error(`[whale:${name}]`, e instanceof Error ? e.message : e);
    }
  }
}

/** 노이즈 트레이더: 랜덤 방향·랜덤 간격의 소량 주문 */
async function runNoiseTrader(client: ApiClient, ref: ReferencePrice, name: string) {
  while (true) {
    try {
      const def = SYMBOLS[randInt(0, SYMBOLS.length - 1)];
      const side = Math.random() < 0.5 ? "BUY" : "SELL";
      const qty = randInt(1, 10);
      if (Math.random() < 0.4) {
        await client.placeOrder({ symbol: def.symbol, side, type: "MARKET", qty });
      } else {
        const drift = side === "BUY" ? rand(0.995, 1.002) : rand(0.998, 1.005);
        const price = toTick(ref.get(def.symbol) * drift, def);
        await client.placeOrder({ symbol: def.symbol, side, type: "LIMIT", price, qty });
      }
    } catch (e) {
      if (!isRejection(e)) console.error(`[noise:${name}]`, e instanceof Error ? e.message : e);
    }
    await sleep(rand(700, 2500));
  }
}

/** 모멘텀 트레이더: 최근 체결가 추세 추종 */
async function runMomentumTrader(client: ApiClient, name: string) {
  while (true) {
    try {
      const def = SYMBOLS[randInt(0, SYMBOLS.length - 1)];
      const trades = await client.recentTrades(def.symbol, 10);
      if (trades.length >= 5) {
        const latest = trades[0].price;
        const oldest = trades[trades.length - 1].price;
        const momentum = (latest - oldest) / oldest;
        if (Math.abs(momentum) > 0.001) {
          await client.placeOrder({
            symbol: def.symbol,
            side: momentum > 0 ? "BUY" : "SELL",
            type: "MARKET",
            qty: randInt(1, 5),
          });
        }
      }
    } catch (e) {
      if (!isRejection(e)) console.error(`[momentum:${name}]`, e instanceof Error ? e.message : e);
    }
    await sleep(rand(2500, 4500));
  }
}

/** 미체결 주문 잔여물 정리(오래된 노이즈 지정가) */
async function runJanitor(clients: ApiClient[]) {
  while (true) {
    await sleep(30_000);
    for (const client of clients) {
      try {
        const orders = await client.myOrders(100);
        for (const o of orders.filter((o) => ["OPEN", "PARTIAL"].includes(o.status)).slice(10)) {
          await client.cancelOrder(o.id).catch(() => {});
        }
      } catch {
        // 무시
      }
    }
  }
}

async function main() {
  console.log("[bots] logging in 10 bot accounts...");
  const clients: ApiClient[] = [];
  for (let i = 1; i <= 10; i++) {
    const client = new ApiClient(`bot${i}@bots.local`);
    // api가 아직 안 떠 있으면 재시도
    for (let attempt = 1; ; attempt++) {
      try {
        await client.login(BOT_PASSWORD);
        break;
      } catch (e) {
        if (attempt >= 30) throw e;
        console.log(`[bots] api not ready, retrying (${attempt})...`);
        await sleep(2000);
      }
    }
    clients.push(client);
  }

  const ref = new ReferencePrice(SYMBOLS);
  setInterval(() => ref.tick(), 1500);

  // 봇 1~3: 마켓메이커 (5종목 분담 — 유동성 공급)
  SYMBOLS.forEach((def, i) => void runMarketMaker(clients[i % 3], def, ref));
  // 봇 4~6: 소액 개미 투자자 (소량·추세추종)
  for (let i = 3; i < 6; i++) void runRetailTrader(clients[i], ref, `bot${i + 1}`);
  // 봇 7: 고래 (대량·저빈도, 가격 충격)
  void runWhale(clients[6], ref, "bot7");
  // 봇 8~9: 노이즈 트레이더 (순수 랜덤)
  for (let i = 7; i < 9; i++) void runNoiseTrader(clients[i], ref, `bot${i + 1}`);
  // 봇 10: 모멘텀 트레이더 (추세 가속)
  void runMomentumTrader(clients[9], "bot10");
  void runJanitor(clients.slice(3));

  console.log("[bots] market makers x3(5종목), retail x3, whale x1, noise x2, momentum x1 running");
}

main().catch((e) => {
  console.error("[bots] fatal", e);
  process.exit(1);
});
