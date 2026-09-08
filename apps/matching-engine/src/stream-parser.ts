import type { OrderStreamEvent } from "@mock-kabu/shared";

export type StreamReply = [key: string, messages: [id: string, fields: string[]][]][] | null;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Keep an untrusted Redis payload out of the matching engine's state machine. */
export function isOrderStreamEvent(value: unknown): value is OrderStreamEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  if (
    !isNonEmptyString(event.eventId) ||
    !isNonEmptyString(event.orderId) ||
    !isNonEmptyString(event.symbol) ||
    typeof event.ts !== "number" ||
    !Number.isFinite(event.ts)
  ) {
    return false;
  }

  if (event.topic === "order.cancel.requested") return true;
  if (event.topic !== "order.placed") return false;

  const validPrice =
    event.type === "LIMIT"
      ? typeof event.price === "number" && Number.isFinite(event.price) && event.price > 0
      : event.price === null || (typeof event.price === "number" && Number.isFinite(event.price) && event.price > 0);

  return (
    isNonEmptyString(event.accountId) &&
    (event.side === "BUY" || event.side === "SELL") &&
    (event.type === "LIMIT" || event.type === "MARKET") &&
    Number.isSafeInteger(event.qty) &&
    (event.qty as number) > 0 &&
    validPrice
  );
}

/**
 * Parse only valid Redis stream payloads. Invalid rows intentionally remain
 * unacknowledged in the consumer group's pending list, but must never bring
 * down the process or prevent a later valid row from being processed.
 */
export function parseOrderStreamMessages(reply: StreamReply): { id: string; ev: OrderStreamEvent }[] {
  if (!reply) return [];
  const out: { id: string; ev: OrderStreamEvent }[] = [];
  for (const [, messages] of reply) {
    for (const [id, fields] of messages) {
      const idx = fields.indexOf("payload");
      const payload = idx >= 0 ? fields[idx + 1] : undefined;
      if (!payload) {
        console.error(`[engine] stream message ${id} has no payload; retained for retry`);
        continue;
      }
      try {
        const event = JSON.parse(payload) as unknown;
        if (!isOrderStreamEvent(event)) {
          console.error(`[engine] invalid stream payload ${id}; retained for retry`);
          continue;
        }
        out.push({ id, ev: event });
      } catch (error) {
        console.error(`[engine] malformed stream payload ${id}; retained for retry`, error);
      }
    }
  }
  return out;
}
