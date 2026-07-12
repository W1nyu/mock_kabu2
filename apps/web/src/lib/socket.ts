"use client";

import { io, type Socket } from "socket.io-client";
import { API_URL, getToken } from "./api";

let socket: Socket | null = null;

/** 채널별 구독 수 — 마지막 구독자가 해제될 때만 룸에서 leave */
const refCounts = new Map<string, number>();

export function getSocket(): Socket {
  if (!socket) {
    socket = io(API_URL, {
      transports: ["websocket"],
      auth: { token: getToken() },
    });
    // 재연결 시 구독 중인 전체 채널 재-join
    socket.on("connect", () => {
      const channels = [...refCounts.keys()];
      if (channels.length > 0) socket!.emit("join", channels);
    });
  }
  return socket;
}

/** 채널 구독 + 핸들러 등록. 반환된 함수로 해제 */
export function subscribe(
  channels: string[],
  handler: (msg: { channel: string; data: any }) => void,
): () => void {
  const s = getSocket();
  const wanted = new Set(channels);
  const wrapped = (msg: { channel: string; data: any }) => {
    if (wanted.has(msg.channel)) handler(msg);
  };

  const toJoin = channels.filter((ch) => (refCounts.get(ch) ?? 0) === 0);
  for (const ch of channels) refCounts.set(ch, (refCounts.get(ch) ?? 0) + 1);
  if (toJoin.length > 0) s.emit("join", toJoin);
  s.on("message", wrapped);

  return () => {
    s.off("message", wrapped);
    const toLeave: string[] = [];
    for (const ch of channels) {
      const next = (refCounts.get(ch) ?? 1) - 1;
      if (next <= 0) {
        refCounts.delete(ch);
        toLeave.push(ch);
      } else {
        refCounts.set(ch, next);
      }
    }
    if (toLeave.length > 0) s.emit("leave", toLeave);
  };
}
