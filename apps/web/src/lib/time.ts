/**
 * All market times render in KST, regardless of where the viewer sits.
 *
 * An exchange quotes one clock. Formatting against the browser's timezone
 * would relabel the same trade differently for two people looking at the same
 * tape, and it also makes the server-rendered HTML disagree with the client on
 * hydration. Asia/Seoul is a fixed UTC+9 with no DST, so every boundary the
 * chart's time axis lands on stays aligned after the shift.
 */
export const MARKET_TIME_ZONE = "Asia/Seoul";
export const MARKET_TIME_ZONE_LABEL = "KST";

/** UTC+9, in seconds. Used where a library can only render UTC. */
export const MARKET_UTC_OFFSET_SECONDS = 9 * 60 * 60;

// hourCycle rather than hour12: ko-KR with `hour12: false` renders midnight as
// "24:05" on several engines, which reads as a bug on a trade tape.
const HMS = new Intl.DateTimeFormat("ko-KR", {
  timeZone: MARKET_TIME_ZONE,
  hourCycle: "h23",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

const HM = new Intl.DateTimeFormat("ko-KR", {
  timeZone: MARKET_TIME_ZONE,
  hourCycle: "h23",
  hour: "2-digit",
  minute: "2-digit",
});

const MONTH_DAY = new Intl.DateTimeFormat("ko-KR", {
  timeZone: MARKET_TIME_ZONE,
  month: "numeric",
  day: "numeric",
});

const YMD = new Intl.DateTimeFormat("en-CA", {
  timeZone: MARKET_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function valid(ts: number): boolean {
  return Number.isFinite(ts) && !Number.isNaN(new Date(ts).getTime());
}

/** HH:mm:ss in KST. Fixed width so a tape's columns stay aligned. */
export function formatKstTime(ts: number): string {
  return valid(ts) ? HMS.format(ts) : "--:--:--";
}

/** HH:mm in KST. */
export function formatKstHm(ts: number): string {
  return valid(ts) ? HM.format(ts) : "--:--";
}

/** "M/D" in KST. */
export function formatKstMonthDay(ts: number): string {
  return valid(ts) ? MONTH_DAY.format(ts).replace(/\.\s*$/, "").replace(/\.\s*/g, "/") : "-/-";
}

/** Calendar day in KST as YYYY-MM-DD, for same-day comparisons. */
export function kstDayKey(ts: number): string {
  return valid(ts) ? YMD.format(ts) : "";
}

export function isSameKstDay(a: number, b: number): boolean {
  const left = kstDayKey(a);
  return left !== "" && left === kstDayKey(b);
}
