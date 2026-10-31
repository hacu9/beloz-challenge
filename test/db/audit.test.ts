import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { withTx } from "../../src/platform/db/tx.js";
import { runWithContext } from "../../src/platform/request-context.js";
import { createHarness } from "../support/harness.js";

const h = createHarness();
afterAll(() => h.close());

describe("audit log", () => {
  it("AUDIT-01: records actor, action, entity, before, after, request ID and clock time", async () => {
    const entityId = randomUUID();
    await runWithContext({ requestId: "req-audit-1" }, () =>
      withTx(h.pool, (tx) =>
        h.deps.audit.write(tx, {
          actor: { type: "ops", id: "ops-7" },
          action: "account.freeze",
          entityType: "account",
          entityId,
          before: { status: "active" },
          after: { status: "frozen" },
        }),
      ),
    );
    const { rows } = await h.pool.query("SELECT * FROM audit_log WHERE entity_id = $1", [entityId]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor_type: "ops",
      actor_id: "ops-7",
      action: "account.freeze",
      entity_type: "account",
      before: { status: "active" },
      after: { status: "frozen" },
      request_id: "req-audit-1",
      at: h.clock.now(),
    });
  });

  it("AUDIT-02: the audit row rolls back with the change", async () => {
    const entityId = randomUUID();
    await expect(
      withTx(h.pool, async (tx) => {
        await h.deps.audit.write(tx, {
          actor: { type: "system" },
          action: "noop",
          entityType: "account",
          entityId,
          before: null,
          after: null,
        });
        throw new Error("change failed");
      }),
    ).rejects.toThrow("change failed");
    const { rowCount } = await h.pool.query("SELECT 1 FROM audit_log WHERE entity_id = $1", [
      entityId,
    ]);
    expect(rowCount).toBe(0);
  });
});
