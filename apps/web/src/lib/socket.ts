"use client";

import { io, type Socket } from "socket.io-client";
import { API_URL, getToken } from "./api";

let socket: Socket | null = null;

export function getSocket(): Socket {
  if (!socket) {
    socket = io(API_URL, {
      transports: ["websocket"],
      auth: { token: getToken() },
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
  const join = () => s.emit("join", channels);
  join();
  s.on("connect", join); // 재연결 시 재구독
  s.on("message", handler);
  return () => {
    s.off("message", handler);
    s.off("connect", join);
    s.emit("leave", channels);
  };
}
