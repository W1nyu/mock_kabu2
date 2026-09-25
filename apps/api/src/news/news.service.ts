import { timingSafeEqual } from "node:crypto";
import { BadRequestException, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import type { PrismaClient } from "@mock-kabu/db";
import { CHANNELS, NEWS_FEED_SCOPE, SYMBOLS, type NewsItemDto } from "@mock-kabu/shared";
import type Redis from "ioredis";
import { PRISMA, REDIS } from "../core/tokens";
// Same trust boundary as the liquidity endpoint: the local bots process
// talking to the local API without a user session.
import { liquidityBootstrapToken } from "../liquidity/liquidity-reserve";

const SYMBOL_NAMES = new Map(SYMBOLS.map((symbol) => [symbol.symbol, symbol.name]));
const ACTIVE_SYMBOLS = new Set(SYMBOLS.map((symbol) => symbol.symbol));

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 40;

export interface PublishNewsDto {
  externalId?: unknown;
  parentExternalId?: unknown;
  symbol?: unknown;
  category?: unknown;
  headline?: unknown;
  body?: unknown;
  sentiment?: unknown;
  impact?: unknown;
}

interface NewsRow {
  id: string;
  symbol: string | null;
  category: string;
  headline: string;
  body: string | null;
  createdAt: Date;
}

@Injectable()
export class NewsService {
  constructor(
    @Inject(PRISMA) private prisma: PrismaClient,
    @Inject(REDIS) private redis: Redis,
  ) {}

  /**
   * The public projection.
   *
   * `sentiment` and `impact` are stored but never selected here. Keeping the
   * omission in one function means the REST response and the websocket payload
   * cannot drift apart and start leaking a story's direction.
   */
  private toPublicDto(row: NewsRow): NewsItemDto {
    return {
      id: row.id,
      symbol: row.symbol,
      symbolName: row.symbol ? (SYMBOL_NAMES.get(row.symbol) ?? null) : null,
      category: row.category,
      headline: row.headline,
      body: row.body,
      ts: row.createdAt.getTime(),
    };
  }

  /**
   * `only`을 주면 그 종목들의 기사만(산업군 피드), `null`이면 시장 전반 기사만 돌려준다.
   */
  async list(
    symbol: string | undefined,
    limit: number,
    only?: readonly string[] | null,
  ): Promise<NewsItemDto[]> {
    const take = Number.isFinite(limit) ? Math.min(Math.max(1, Math.trunc(limit)), MAX_LIMIT) : DEFAULT_LIMIT;
    const where =
      only === null
        ? { symbol: null }
        : only
          ? { symbol: { in: [...only] } }
          : // A market-wide story moved this symbol too, so it belongs in its feed.
            symbol
            ? { OR: [{ symbol }, { symbol: null }] }
            : {};

    const rows = await this.prisma.newsItem.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take,
      select: {
        id: true,
        symbol: true,
        category: true,
        headline: true,
        body: true,
        createdAt: true,
      },
    });
    return rows.map((row) => this.toPublicDto(row));
  }

  async publish(token: string | undefined, dto: PublishNewsDto): Promise<{ id: string }> {
    this.assertToken(token);

    const externalId = requireString(dto.externalId, "externalId");
    const category = requireString(dto.category, "category");
    const headline = requireString(dto.headline, "headline");
    const sentiment = requireString(dto.sentiment, "sentiment");
    if (sentiment !== "POSITIVE" && sentiment !== "NEGATIVE") {
      throw new BadRequestException("sentiment must be POSITIVE or NEGATIVE");
    }
    if (!Number.isInteger(dto.impact) || (dto.impact as number) < 0 || (dto.impact as number) > 100) {
      throw new BadRequestException("impact must be an integer between 0 and 100");
    }

    const symbol = dto.symbol == null ? null : requireString(dto.symbol, "symbol");
    if (symbol !== null && !ACTIVE_SYMBOLS.has(symbol)) {
      throw new BadRequestException(`unknown symbol: ${symbol}`);
    }
    const body = dto.body == null ? null : requireString(dto.body, "body");
    const parentExternalId =
      dto.parentExternalId == null ? null : requireString(dto.parentExternalId, "parentExternalId");

    // Not shown anywhere. Stamped because it is what makes a later
    // "did this story actually move the price" analysis possible, the same
    // reason sentiment and impact are stored but never served.
    const priceAtPublish = symbol
      ? ((await this.prisma.marketSymbol.findUnique({ where: { symbol }, select: { lastPrice: true } }))
          ?.lastPrice ?? null)
      : null;

    const row = await this.prisma.newsItem.upsert({
      where: { externalId },
      create: {
        externalId,
        parentExternalId,
        symbol,
        category,
        headline,
        body,
        sentiment,
        impact: dto.impact as number,
        priceAtPublish,
      },
      // A retry after a network failure must not duplicate a headline.
      update: {},
      select: {
        id: true,
        symbol: true,
        category: true,
        headline: true,
        body: true,
        createdAt: true,
      },
    });

    await this.broadcast(this.toPublicDto(row));
    return { id: row.id };
  }

  private async broadcast(item: NewsItemDto): Promise<void> {
    const payload = JSON.stringify(item);
    // A market-wide story is delivered to every symbol channel as well, so a
    // symbol panel only ever needs to subscribe to its own channel.
    const scopes = item.symbol
      ? [item.symbol, NEWS_FEED_SCOPE]
      : [...ACTIVE_SYMBOLS, NEWS_FEED_SCOPE];

    await Promise.all(
      scopes.map((scope) =>
        this.redis.publish(CHANNELS.news(scope), payload).catch((error) => {
          console.error("[news] publish to", scope, "failed", error);
        }),
      ),
    );
  }

  private assertToken(presentedToken: string | undefined) {
    const expected = Buffer.from(liquidityBootstrapToken());
    const presented = Buffer.from(presentedToken ?? "");
    if (expected.length !== presented.length || !timingSafeEqual(expected, presented)) {
      throw new UnauthorizedException("invalid liquidity bootstrap token");
    }
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new BadRequestException(`${field} must be a non-empty string`);
  }
  return value;
}
