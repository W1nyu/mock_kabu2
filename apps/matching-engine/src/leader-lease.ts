import { randomUUID } from "node:crypto";
import type Redis from "ioredis";

const RENEW_IF_OWNER = `
  if redis.call("GET", KEYS[1]) == ARGV[1] then
    return redis.call("PEXPIRE", KEYS[1], ARGV[2])
  end
  return 0
`;

const RELEASE_IF_OWNER = `
  if redis.call("GET", KEYS[1]) == ARGV[1] then
    return redis.call("DEL", KEYS[1])
  end
  return 0
`;

/**
 * A small Redis lease for the matching engine's single in-memory orderbook.
 *
 * The token is deliberately random per process.  Renewal and release use Lua
 * compare-and-act scripts, so an old process can never extend or delete a
 * lease acquired by a newer leader after its own TTL expired.
 */
export class RedisLeaderLease {
  private held = false;

  readonly token: string;

  constructor(
    private readonly redis: Pick<Redis, "set" | "eval">,
    readonly key: string,
    readonly ttlMs: number,
    token: string = randomUUID(),
  ) {
    if (!Number.isInteger(ttlMs) || ttlMs <= 0) {
      throw new Error("leader lease ttl must be a positive integer");
    }
    this.token = token;
  }

  get isHeld(): boolean {
    return this.held;
  }

  async acquire(): Promise<boolean> {
    if (this.held) return true;
    const result = await this.redis.set(this.key, this.token, "PX", this.ttlMs, "NX");
    this.held = result === "OK";
    return this.held;
  }

  /**
   * A Redis error is treated as lease loss by the caller.  Clearing local
   * ownership here prevents a later shutdown path from touching an unknown
   * successor lease.
   */
  async renew(): Promise<boolean> {
    if (!this.held) return false;
    try {
      const result = await this.redis.eval(RENEW_IF_OWNER, 1, this.key, this.token, String(this.ttlMs));
      this.held = Number(result) === 1;
      return this.held;
    } catch (error) {
      this.held = false;
      throw error;
    }
  }

  /** Token-safe best-effort release. Never deletes a successor's lease. */
  async release(): Promise<boolean> {
    if (!this.held) return false;
    this.held = false;
    const result = await this.redis.eval(RELEASE_IF_OWNER, 1, this.key, this.token);
    return Number(result) === 1;
  }
}
