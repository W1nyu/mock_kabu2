import { timingSafeEqual } from "node:crypto";
import { BadRequestException, Inject, Injectable, Optional, UnauthorizedException } from "@nestjs/common";
import type { Prisma, PrismaClient } from "@mock-kabu/db";
import {
  KEYS,
  referenceAsset,
  DELISTED_SYMBOLS,
  CHANNELS,
  industryById,
  industryOf,
  NEWS_FEED_SCOPE,
  SYMBOLS,
  type IndustryDef,
  type NewsItemDto,
  type NewsTranslationsDto,
} from "@mock-kabu/shared";
import type Redis from "ioredis";
import { MemoCache } from "../core/memo-cache";
import { PRISMA, REDIS } from "../core/tokens";
// Same trust boundary as the liquidity endpoint: the local bots process
// talking to the local API without a user session.
import { liquidityBootstrapToken } from "../liquidity/liquidity-reserve";

// 상장 폐지 종목의 과거 기사에도 이름이 나오게 폐지 목록까지 담는다.
const SYMBOL_NAMES = new Map([...SYMBOLS, ...DELISTED_SYMBOLS].map((symbol) => [symbol.symbol, symbol.name]));
const ACTIVE_SYMBOLS = new Set(SYMBOLS.map((symbol) => symbol.symbol));

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 40;
/**
 * 공개 뉴스 목록은 모든 접속자가 같은 질의를 반복한다. 2초 공유하고, 새 기사가 발행되면 바로 비운다.
 * 실시간 새 기사는 소켓으로 가므로 목록 캐시는 첫 화면·재연결 보조용이다.
 */
const LIST_TTL_MS = 2_000;
const LIST_CACHE_PREFIX = "news:list:";

export interface PublishNewsDto {
  externalId?: unknown;
  parentExternalId?: unknown;
  symbol?: unknown;
  industry?: unknown;
  category?: unknown;
  headline?: unknown;
  body?: unknown;
  sentiment?: unknown;
  impact?: unknown;
  referenceCodes?: unknown;
  translations?: unknown;
}

interface NewsRow {
  id: string;
  symbol: string | null;
  industry: string | null;
  referenceCodes: string[];
  category: string;
  headline: string;
  body: string | null;
  translations?: unknown;
  createdAt: Date;
}

@Injectable()
export class NewsService {
  constructor(
    @Inject(PRISMA) private prisma: PrismaClient,
    @Inject(REDIS) private redis: Redis,
    @Optional() private cache: MemoCache = new MemoCache(),
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
      industry: row.industry,
      referenceCodes: row.referenceCodes,
      category: row.category,
      headline: row.headline,
      body: row.body,
      translations: sanitizeTranslations(row.translations) ?? {},
      ts: row.createdAt.getTime(),
    };
  }

  /**
   * `industry`를 주면 그 산업군 피드(소속 종목 기사 + 산업군 기사), `null`이면 시장 전반 기사만.
   * 종목 피드에는 그 종목 기사, 시장 전반 기사, 그 종목이 속한 산업군 기사가 함께 나온다.
   * `ownOnly`면 그 종목 기사만.
   */
  async list(
    symbol: string | undefined,
    limit: number,
    industry?: IndustryDef | null,
    ownOnly = false,
    /** 이 기초자산 코드 중 하나라도 움직인 기사 */
    reference?: readonly string[],
  ): Promise<NewsItemDto[]> {
    const take = Number.isFinite(limit) ? Math.min(Math.max(1, Math.trunc(limit)), MAX_LIMIT) : DEFAULT_LIMIT;
    const marketWide = { symbol: null, industry: null };
    const own = symbol ? industryOf(symbol) : null;
    const where = reference
      ? // 선물·원자재 화면: 그 기초자산을 움직인 기사
        { referenceCodes: { hasSome: [...reference] } }
      : industry === null
        ? marketWide
        : industry
          ? { OR: [{ symbol: { in: [...industry.symbols] } }, { industry: industry.id }] }
          : symbol && ownOnly
            ? // 종목 화면의 "이 종목" 탭 — 그 종목을 직접 다룬 기사만.
              { symbol }
            : symbol
              ? // A market-wide or industry story moved this symbol too, so it belongs in its feed.
                { OR: [{ symbol }, marketWide, ...(own ? [{ industry: own.id }] : [])] }
              : {};

    const key = `${LIST_CACHE_PREFIX}${symbol ?? ""}:${ownOnly ? "own" : ""}:${reference ?? ""}:${industry === null ? "market" : (industry?.id ?? "")}:${take}`;
    return this.cache.getOrCompute(key, LIST_TTL_MS, () => this.query(where, take));
  }

  private async query(where: Prisma.NewsItemWhereInput, take: number): Promise<NewsItemDto[]> {
    const rows = await this.prisma.newsItem.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take,
      select: {
        id: true,
        symbol: true,
        industry: true,
        referenceCodes: true,
        category: true,
        headline: true,
        body: true,
        translations: true,
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
    const industry = dto.industry == null ? null : requireString(dto.industry, "industry");
    if (industry !== null && (symbol !== null || !industryById(industry))) {
      throw new BadRequestException(`invalid industry: ${industry}`);
    }
    const body = dto.body == null ? null : requireString(dto.body, "body");
    const referenceCodes = dto.referenceCodes == null ? [] : dto.referenceCodes;
    if (!Array.isArray(referenceCodes) || referenceCodes.some((code) => typeof code !== "string" || !referenceAsset(code))) {
      throw new BadRequestException("referenceCodes must be known reference asset codes");
    }
    const parentExternalId =
      dto.parentExternalId == null ? null : requireString(dto.parentExternalId, "parentExternalId");
    const translations = dto.translations == null ? {} : sanitizeTranslations(dto.translations);
    if (translations === null) throw new BadRequestException("translations must be {en|ja: {headline, body}}");

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
        industry,
        category,
        headline,
        body,
        sentiment,
        impact: dto.impact as number,
        priceAtPublish,
        referenceCodes: [...new Set(referenceCodes as string[])],
        translations: translations as Prisma.InputJsonObject,
      },
      // A retry after a network failure must not duplicate a headline.
      update: {},
      select: {
        id: true,
        symbol: true,
        industry: true,
        referenceCodes: true,
        category: true,
        headline: true,
        body: true,
        translations: true,
        createdAt: true,
      },
    });

    this.cache.invalidate(LIST_CACHE_PREFIX);
    await this.broadcast(this.toPublicDto(row));
    return { id: row.id };
  }

  private async broadcast(item: NewsItemDto): Promise<void> {
    const payload = JSON.stringify(item);
    // A market-wide story is delivered to every symbol channel as well, and an
    // industry story to its industry's symbols, so a symbol panel only ever needs
    // to subscribe to its own channel.
    const industry = item.industry ? industryById(item.industry) : null;
    const scopes = item.symbol
      ? [item.symbol, NEWS_FEED_SCOPE]
      : industry
        ? [...industry.symbols, NEWS_FEED_SCOPE]
        : [...ACTIVE_SYMBOLS, NEWS_FEED_SCOPE];

    await Promise.all(
      scopes.map((scope) =>
        this.redis.publish(CHANNELS.news(scope), payload).catch((error) => {
          console.error("[news] publish to", scope, "failed", error);
        }),
      ),
    );
  }

  /**
   * 운영자 도구: 시장 기사 템플릿(macro.*)을 즉시 발행해 달라고 봇에 요청한다. 봇이 5초마다 꺼내 가
   * 평소와 같은 경로(주가 영향·기초자산 반응 포함)로 발행한다. 템플릿 존재 여부는 봇이 확인한다.
   */
  async requestForcedNews(token: string | undefined, templateId: unknown): Promise<{ queued: string }> {
    this.assertToken(token);
    const id = requireString(templateId, "templateId");
    if (!/^macro\.[a-z0-9.\-]{1,60}$/.test(id)) throw new BadRequestException("templateId must be a macro.* template id");
    const key = KEYS.newsForceQueue();
    await this.redis.lpush(key, id);
    await this.redis.expire(key, 600);
    return { queued: id };
  }

  /** 봇 전용: 요청된 템플릿 하나를 꺼낸다(없으면 null). */
  async takeForcedNews(token: string | undefined): Promise<{ templateId: string | null }> {
    this.assertToken(token);
    return { templateId: await this.redis.rpop(KEYS.newsForceQueue()) };
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

const TRANSLATION_LOCALES = ["en", "ja"] as const;
const MAX_HEADLINE = 400;
const MAX_BODY = 2_000;

/** 번역 객체를 {en|ja: {headline, body}}만 남겨 돌려준다. 모양이 틀리면 null. */
export function sanitizeTranslations(value: unknown): NewsTranslationsDto | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return null;
  const out: NewsTranslationsDto = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!(TRANSLATION_LOCALES as readonly string[]).includes(key)) return null;
    if (entry == null || typeof entry !== "object") return null;
    const { headline, body } = entry as { headline?: unknown; body?: unknown };
    if (typeof headline !== "string" || headline.length === 0 || headline.length > MAX_HEADLINE) return null;
    if (body != null && (typeof body !== "string" || body.length > MAX_BODY)) return null;
    out[key as "en" | "ja"] = { headline, body: (body as string | null | undefined) ?? null };
  }
  return out;
}
