import { Inject, Injectable } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from "@nestjs/websockets";
import type Redis from "ioredis";
import type { Server, Socket } from "socket.io";
import {
  CHANNELS,
  NEWS_FEED_SCOPE,
  REDIS_CHANNEL_PATTERNS,
  SYMBOLS,
  toSocketChannel,
} from "@mock-kabu/shared";
import { REDIS, REDIS_SUB } from "../core/tokens";
import { readApiRuntimeConfig } from "../core/runtime-config";

const WEB_ORIGINS = readApiRuntimeConfig().webOrigins;
const ACTIVE_SYMBOLS = new Set(SYMBOLS.map((symbol) => symbol.symbol));
const MAX_CHANNELS_PER_MESSAGE = 32;

/**
 * 실시간 채널 중계:
 *  - orderbook:{symbol}, trades:{symbol} : Redis Pub/Sub(매칭 엔진 발행) → 소켓 룸으로 중계
 *  - account:{accountId} : 인증된 본인만 구독 가능, 잔액/주문 변경 알림
 */
@Injectable()
@WebSocketGateway({ cors: { origin: WEB_ORIGINS, credentials: true } })
export class RealtimeGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;
  /** Local socket refcounts for exact private Redis subscriptions. */
  private readonly accountChannelRefs = new Map<string, number>();
  private readonly accountChannelBySocket = new Map<string, string>();
  private readonly activeAccountSubscriptions = new Set<string>();
  private readonly pendingAccountSubscriptions = new Set<string>();

  constructor(
    @Inject(REDIS_SUB) private sub: Redis,
    @Inject(REDIS) private publisher: Redis,
    private jwt: JwtService,
  ) {}

  afterInit() {
    this.sub.psubscribe(
      REDIS_CHANNEL_PATTERNS.orderbook,
      REDIS_CHANNEL_PATTERNS.trades,
      REDIS_CHANNEL_PATTERNS.news,
    ).catch((e) => {
      console.error("[gateway] psubscribe failed", e);
    });
    this.sub.on("pmessage", (_pattern, channel, message) => {
      this.relayRedisMessage(channel, message);
    });
    // Private account channels are subscribed only while a local, authorized
    // Socket.IO room has a listener. A broad account:* pattern would make
    // every API replica parse every account update as the user base grows.
    this.sub.on("message", (channel, message) => {
      this.relayRedisMessage(channel, message);
    });
  }

  handleConnection(socket: Socket) {
    const token = socket.handshake.auth?.token as string | undefined;
    if (token) {
      try {
        const payload = this.jwt.verify(token);
        socket.data.accountId = payload.accountId;
      } catch {
        // 토큰이 유효하지 않아도 공개 채널(호가/체결)은 구독 가능
      }
    }
  }

  handleDisconnect(socket: Socket) {
    this.releaseAccountChannel(socket);
  }

  connectionSnapshot() {
    const sockets = [...(this.server?.sockets.sockets.values() ?? [])];
    const accounts = new Set(sockets.map((socket) => socket.data.accountId).filter(Boolean));
    return {
      connectedSockets: sockets.length,
      authenticatedSockets: sockets.filter((socket) => socket.data.accountId).length,
      uniqueAuthenticatedAccounts: accounts.size,
      anonymousSockets: sockets.filter((socket) => !socket.data.accountId).length,
      scope: "this API process; sockets include multiple tabs; accounts reflect handshake authentication",
    };
  }

  @SubscribeMessage("join")
  join(@ConnectedSocket() socket: Socket, @MessageBody() channels: unknown) {
    for (const ch of this.allowedChannels(socket, channels)) {
      const alreadyJoined = socket.rooms.has(ch);
      socket.join(ch);
      if (!alreadyJoined && this.isAccountChannel(ch)) this.retainAccountChannel(socket, ch);
    }
    return { ok: true };
  }

  @SubscribeMessage("leave")
  leave(@ConnectedSocket() socket: Socket, @MessageBody() channels: unknown) {
    for (const ch of this.allowedChannels(socket, channels)) {
      const wasJoined = socket.rooms.has(ch);
      socket.leave(ch);
      if (wasJoined && this.isAccountChannel(ch)) this.releaseAccountChannel(socket, ch);
    }
    return { ok: true };
  }

  /**
   * Publish account events through Redis so a WebSocket connected to any API
   * replica observes the same change. Gateway room authorization still keeps
   * account channels private to their owner.
   */
  notifyAccount(accountId: string, payload: Record<string, unknown>) {
    this.publisher.publish(CHANNELS.account(accountId), JSON.stringify(payload)).catch((error) => {
      // This is an ephemeral UI invalidation; settlement/order durability is
      // provided by the streams and database transactions, not Pub/Sub.
      console.error(`[gateway] account notification publish failed for ${accountId}`, error);
    });
  }

  private relayRedisMessage(channel: string, message: string): void {
    try {
      const socketChannel = toSocketChannel(channel);
      if (!socketChannel) return;
      this.server.to(socketChannel).emit("message", { channel: socketChannel, data: JSON.parse(message) });
    } catch (error) {
      console.error("[gateway] relay failed", error);
    }
  }

  private retainAccountChannel(socket: Socket, channel: string): void {
    const previous = this.accountChannelBySocket.get(socket.id);
    if (previous === channel) return;
    if (previous) this.releaseAccountChannel(socket, previous);

    this.accountChannelBySocket.set(socket.id, channel);
    const references = this.accountChannelRefs.get(channel) ?? 0;
    this.accountChannelRefs.set(channel, references + 1);
    this.ensureAccountSubscription(channel);
  }

  private ensureAccountSubscription(channel: string): void {
    if (this.activeAccountSubscriptions.has(channel) || this.pendingAccountSubscriptions.has(channel)) return;
    this.pendingAccountSubscriptions.add(channel);
    void this.sub
      .subscribe(CHANNELS.account(this.accountIdFromChannel(channel)))
      .then(() => {
        if (this.accountChannelRefs.has(channel)) {
          this.activeAccountSubscriptions.add(channel);
          return;
        }
        // The final socket left while Redis was subscribing. Avoid keeping a
        // no-listener channel alive once the asynchronous command completes.
        return this.sub.unsubscribe(CHANNELS.account(this.accountIdFromChannel(channel)));
      })
      .catch((error) => {
        // The next join retries. Account REST polling remains a safe fallback,
        // so an ephemeral subscription failure must not affect funds.
        console.error(`[gateway] account channel subscribe failed: ${channel}`, error);
      })
      .finally(() => {
        this.pendingAccountSubscriptions.delete(channel);
      });
  }

  private releaseAccountChannel(socket: Socket, expectedChannel?: string): void {
    const channel = this.accountChannelBySocket.get(socket.id);
    if (!channel || (expectedChannel && channel !== expectedChannel)) return;
    this.accountChannelBySocket.delete(socket.id);

    const references = this.accountChannelRefs.get(channel) ?? 0;
    if (references > 1) {
      this.accountChannelRefs.set(channel, references - 1);
      return;
    }
    this.accountChannelRefs.delete(channel);
    if (!this.activeAccountSubscriptions.delete(channel)) return;
    this.sub.unsubscribe(CHANNELS.account(this.accountIdFromChannel(channel))).catch((error) => {
      console.error(`[gateway] account channel unsubscribe failed: ${channel}`, error);
    });
  }

  private isAccountChannel(channel: string): boolean {
    return channel.startsWith("account:");
  }

  private accountIdFromChannel(channel: string): string {
    return channel.slice("account:".length);
  }

  private allowedChannels(socket: Socket, channels: unknown): string[] {
    if (!Array.isArray(channels)) return [];

    return channels
      .slice(0, MAX_CHANNELS_PER_MESSAGE)
      .filter((channel): channel is string => typeof channel === "string" && channel.length <= 96)
      .filter((channel) => this.isAllowedChannel(socket, channel));
  }

  private isAllowedChannel(socket: Socket, channel: string): boolean {
    if (socket.data.accountId && channel === `account:${socket.data.accountId}`) return true;

    const [kind, scope, ...rest] = channel.split(":");
    if (rest.length !== 0) return false;

    // News is public like trades and depth. The firehose scope carries every
    // story; a per-symbol scope carries that symbol's plus the market-wide ones.
    if (kind === "news") return scope === NEWS_FEED_SCOPE || ACTIVE_SYMBOLS.has(scope);
    return (kind === "orderbook" || kind === "trades") && ACTIVE_SYMBOLS.has(scope);
  }
}
