// Read-only Socket.IO + market HTTP traffic. No login, signup, or order writes.
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
const require = createRequire(process.env.LOAD_WEB_PACKAGE || '/app/apps/web/package.json');
const { io } = require('socket.io-client');
const [target, rawUsers = '5', rawSeconds = '30'] = process.argv.slice(2);
const users = Number(rawUsers), seconds = Number(rawSeconds);
if (!target || !/^https?:\/\//.test(target) || !Number.isInteger(users) || users < 1 || users > 500 ||
    !Number.isInteger(seconds) || seconds < 5 || seconds > 600) {
  console.error('Usage: load.mjs URL users(1..500, default 5) seconds(5..600, default 30)');
  process.exit(2);
}
const origin = new URL(target).origin;
const sockets = [], latencies = [];
let connected = 0, peak = 0, errors = 0, messages = 0, bytes = 0, requests = 0, httpErrors = 0;
let stopped = false, usersReceiving = 0;
const started = performance.now();
const until = started + seconds * 1000;
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
function cleanup() { stopped = true; for (const socket of sockets) socket.disconnect(); }
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
await Promise.all(Array.from({ length: users }, async (_, index) => {
  await sleep(index * Math.min(100, seconds * 200 / users));
  if (stopped || performance.now() >= until) return;
  const symbol = ['KABU', 'MOCK', 'NEKO', 'SAKU', 'TANU'][index % 5];
  const socket = io(origin, { transports: ['websocket'], forceNew: true, reconnection: false, timeout: 5000 });
  sockets.push(socket);
  let active = false, received = false;
  socket.on('connect', () => {
    active = true; connected++; peak = Math.max(peak, connected);
    socket.emit('join', [`orderbook:${symbol}`, `trades:${symbol}`]);
  });
  socket.on('disconnect', () => { if (active) connected--; active = false; });
  socket.on('connect_error', () => { errors++; });
  socket.on('message', data => {
    messages++; bytes += Buffer.byteLength(JSON.stringify(data));
    if (!received) { received = true; usersReceiving++; }
  });
  while (!stopped && performance.now() < until) {
    const begin = performance.now();
    requests++;
    try {
      const response = await fetch(`${origin}/market/symbols`, { signal: AbortSignal.timeout(5000) });
      await response.arrayBuffer();
      if (!response.ok) httpErrors++;
    } catch { httpErrors++; }
    latencies.push(performance.now() - begin);
    await sleep(Math.max(0, Math.min(5000, until - performance.now())));
  }
}));
const finalConnected = connected;
cleanup();
latencies.sort((a,b) => a-b);
const p = value => latencies.length ? Math.round(latencies[Math.max(0, Math.ceil(latencies.length * value)-1)]) : null;
const result = { origin, requestedUsers: users, elapsedSeconds: Math.round((performance.now()-started)/1000),
  peakSockets: peak, finalConnected, usersReceiving, connectionErrors: errors, messages, payloadBytes: bytes,
  httpRequests: requests, httpErrors, httpP50Ms: p(.5), httpP95Ms: p(.95),
  note: 'Read-only market scenario; no orders, authentication or full browser rendering. Same-host generator competes for CPU.' };
console.log(JSON.stringify(result, null, 2));
if (errors || httpErrors || usersReceiving !== users || finalConnected !== users) process.exitCode = 1;
