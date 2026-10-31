import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { progressClosures } from "../../src/jobs/progress-closures.js";
import { createHarness, testConfig } from "../support/harness.js";
import { activeAccount } from "../support/actors.js";

const h = createHarness();
afterAll(() => h.close());
const app = h.app();

describe("review D3: job runs are traceable", () => {
  it("every audit row and journal entry a job writes carries the job's run ID", async () => {
    const a = await activeAccount(app, h, 100_000);
    await request(app)
      .post(`/v1/accounts/${a.view.id}/close`)
      .set("Authorization", a.auth)
      .set("Idempotency-Key", randomUUID())
      .send({});
    h.clock.advanceMs(testConfig.closingCaptureWindowDays * 24 * 60 * 60 * 1000);
    await progressClosures(h.deps, { accountIds: [a.view.id] });

    const audit = await h.pool.query<{ action: string; request_id: string | null }>(
      `SELECT action, request_id FROM audit_log
       WHERE (entity_id = $1::text AND action = 'account.settling')
          OR (entity_type = 'payout'
              AND entity_id IN (SELECT id::text FROM payouts WHERE account_id = $1::uuid))`,
      [a.view.id],
    );
    expect(audit.rows.length).toBeGreaterThan(0);
    const ids = new Set(audit.rows.map((r) => r.request_id));
    expect(ids.size).toBe(1);
    expect([...ids][0]).toMatch(/^job:progress-closures:[0-9a-f-]{36}$/);
  });
});
