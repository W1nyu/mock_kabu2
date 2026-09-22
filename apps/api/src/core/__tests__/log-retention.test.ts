import { describe, expect, it, vi } from "vitest";
import { LOG_RETENTION, pruneBatch, pruneUntilDrained } from "@mock-kabu/shared";

describe("durable log pruning", () => {
  it("deletes one bounded batch by key with the cutoff as the only parameter", async () => {
    const db = { $executeRawUnsafe: vi.fn().mockResolvedValue(3) };
    const before = new Date("2026-09-15T00:00:00Z");
    await pruneBatch(db, {
      table: '"order"."outbox"',
      column: "published_at",
      key: "event_id",
      before,
      extraWhere: '"published_at" IS NOT NULL',
    });
    const [sql, param] = db.$executeRawUnsafe.mock.calls[0];
    expect(sql).toContain('DELETE FROM "order"."outbox" WHERE event_id IN (');
    expect(sql).toContain('WHERE "published_at" < $1 AND "published_at" IS NOT NULL');
    expect(sql).toContain(`LIMIT ${LOG_RETENTION.BATCH_ROWS}`);
    expect(param).toBe(before);
  });

  it("keeps deleting while batches come back full, then stops", async () => {
    const db = {
      $executeRawUnsafe: vi
        .fn()
        .mockResolvedValueOnce(LOG_RETENTION.BATCH_ROWS)
        .mockResolvedValueOnce(LOG_RETENTION.BATCH_ROWS)
        .mockResolvedValueOnce(120),
    };
    const total = await pruneUntilDrained(db, { table: "t", column: "c", before: new Date() });
    expect(total).toBe(LOG_RETENTION.BATCH_ROWS * 2 + 120);
    expect(db.$executeRawUnsafe).toHaveBeenCalledTimes(3);
  });

  it("caps the catch-up loop", async () => {
    const db = { $executeRawUnsafe: vi.fn().mockResolvedValue(LOG_RETENTION.BATCH_ROWS) };
    await pruneUntilDrained(db, { table: "t", column: "c", before: new Date() }, 4);
    expect(db.$executeRawUnsafe).toHaveBeenCalledTimes(4);
  });
});
