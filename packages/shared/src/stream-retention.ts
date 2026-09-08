/**
 * Minimal Redis surface used by the safe stream-retention helper. Keeping it
 * structural lets workers pass their existing command connections without
 * making the shared types package depend on a particular Redis client.
 */
export interface StreamMaintenanceClient {
  xinfo(command: "GROUPS", stream: string): Promise<unknown>;
  xpending(stream: string, group: string, start: string, end: string, count: number): Promise<unknown>;
  xtrim(stream: string, strategy: "MINID", cutoff: string): Promise<unknown>;
}

function field(row: unknown, name: string): unknown {
  if (Array.isArray(row)) {
    for (let index = 0; index + 1 < row.length; index += 2) {
      if (row[index] === name) return row[index + 1];
    }
    return undefined;
  }
  if (row && typeof row === "object") return (row as Record<string, unknown>)[name];
  return undefined;
}

function streamId(value: unknown): string | null {
  const candidate = typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
  return /^\d+-\d+$/.test(candidate) ? candidate : null;
}

/**
 * Trim only records proven safe for this stream's sole consumer group.
 *
 * `last-delivered-id` proves every earlier entry was delivered; when the
 * group has a PEL, its oldest pending id becomes the exclusive lower bound.
 * The current boundary itself is retained, so a malformed Redis response can
 * at worst leave extra history, never discard a financial event.
 */
export async function trimAcknowledgedStream(
  client: StreamMaintenanceClient,
  stream: string,
  group: string,
): Promise<number> {
  const groups = await client.xinfo("GROUPS", stream);
  if (!Array.isArray(groups)) return 0;

  const currentGroup = groups.find((candidate) => field(candidate, "name") === group);
  if (!currentGroup) return 0;

  let cutoff = streamId(field(currentGroup, "last-delivered-id"));
  if (!cutoff || cutoff === "0-0") return 0;

  const pending = Number(field(currentGroup, "pending") ?? 0);
  if (Number.isFinite(pending) && pending > 0) {
    const pendingEntries = await client.xpending(stream, group, "-", "+", 1);
    const firstPending = Array.isArray(pendingEntries) && Array.isArray(pendingEntries[0])
      ? streamId(pendingEntries[0][0])
      : null;
    // Without a trustworthy PEL floor we deliberately skip trimming.
    if (!firstPending) return 0;
    cutoff = firstPending;
  }

  // Exact MINID trimming is intentionally used here. This runs only once a
  // minute and favours the proof that no entry at/after the safe boundary can
  // be discarded over the slightly cheaper approximate form.
  const result = await client.xtrim(stream, "MINID", cutoff);
  return typeof result === "number" ? result : Number(result) || 0;
}
