import { Inject, Injectable } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from "@nestjs/websockets";
import type Redis from "ioredis";
import type { Server, Socket } from "socket.io";
import { REDIS_CHANNEL_PATTERNS, toSocketChannel } from "@mock-kabu/shared";
import { REDIS_SUB } from "../core/tokens";

const WEB_ORIGINS = (process.env.WEB_ORIGIN ?? "http://localhost:3100,http://127.0.0.1:3100")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

/**
 * 실시간 채널 중계:
 *  - orderbook:{symbol}, trades:{symbol} : Redis Pub/Sub(매칭 엔진 발행) → 소켓 룸으로 중계
 *  - account:{accountId} : 인증된 본인만 구독 가능, 잔액/주문 변경 알림
 */
@Injectable()
@WebSocketGateway({ cors: { origin: WEB_ORIGINS, credentials: true } })
export class RealtimeGateway implements OnGatewayInit, OnGatewayConnection {
  @WebSocketServer()
  server: Server;

  constructor(
    @Inject(REDIS_SUB) private sub: Redis,
    private jwt: JwtService,
  ) {}

  afterInit() {
    this.sub.psubscribe(REDIS_CHANNEL_PATTERNS.orderbook, REDIS_CHANNEL_PATTERNS.trades).catch((e) => {
      console.error("[gateway] psubscribe failed", e);
    });
    this.sub.on("pmessage", (_pattern, channel, message) => {
      try {
        const socketChannel = toSocketChannel(channel);
        if (!socketChannel) return;
        this.server.to(socketChannel).emit("message", { channel: socketChannel, data: JSON.parse(message) });
      } catch (e) {
        console.error("[gateway] relay failed", e);
      }
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

  @SubscribeMessage("join")
  join(@ConnectedSocket() socket: Socket, @MessageBody() channels: string[]) {
    for (const ch of channels ?? []) {
      if (ch.startsWith("account:")) {
        if (socket.data.accountId && ch === `account:${socket.data.accountId}`) {
          socket.join(ch);
        }
      } else if (ch.startsWith("orderbook:") || ch.startsWith("trades:")) {
        socket.join(ch);
      }
    }
    return { ok: true };
  }

  @SubscribeMessage("leave")
  leave(@ConnectedSocket() socket: Socket, @MessageBody() channels: string[]) {
    for (const ch of channels ?? []) socket.leave(ch);
    return { ok: true };
  }

  /** 서비스 코드에서 계정 이벤트 push (잔액/주문/체결 변경) */
  notifyAccount(accountId: string, payload: Record<string, unknown>) {
    const channel = `account:${accountId}`;
    this.server?.to(channel).emit("message", { channel, data: payload });
  }
}
