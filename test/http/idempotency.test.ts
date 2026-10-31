import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { issueToken } from "../../src/fakes/fake-login.js";
import { createHarness, listen, testConfig } from "../support/harness.js";
import { mountProbeRoutes } from "../support/probe-routes.js";

const h = createHarness();
const app = h.app({ mount: mountProbeRoutes });
let auth = "";
let otherAuth = "";

beforeAll(async () => {
  auth = `Bearer ${await issueToken({ sub: randomUUID(), role: "customer" }, testConfig.jwtSecret, h.clock)}`;
  otherAuth = `Bearer ${await issueToken({ sub: randomUUID(), role: "customer" }, testConfig.jwtSecret, h.clock)}`;
});
afterAll(() => h.close());

async function changesFor(key: string): Promise<number> {
  const { rowCount } = await h.pool.query(
    "SELECT 1 FROM audit_log WHERE entity_type = 'probe' AND entity_id = $1",
    [key],
  );
  return rowCount ?? 0;
}

const post = (key: string | undefined, body: object, authorization = auth) => {
  const req = request(app).post("/test/transfers").set("Authorization", authorization);
  return (key ? req.set("Idempotency-Key", key) : req).send(body);
};

describe("idempotency", () => {
  it("IDEM-01: a money call without Idempotency-Key is rejected and changes nothing", async () => {
    const res = await post(undefined, { amount: 100 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("idempotency_key_required");
  });

  it("IDEM-02 / IDEM-03: a repeat returns the stored response and changes nothing", async () => {
    const key = randomUUID();
    const first = await post(key, { amount: 100 });
    const second = await post(key, { amount: 100 });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body); // same nonce: replayed, not re-run
    expect(second.headers["idempotent-replayed"]).toBe("true");
    expect(await changesFor(key)).toBe(1);

    const { rows } = await h.pool.query(
      "SELECT response_status, response_body FROM idempotency_keys WHERE key = $1",
      [key],
    );
    expect(rows[0]).toEqual({ response_status: 201, response_body: first.body });
  });

  it("IDEM-04: the same key with a different body returns 422 and changes nothing", async () => {
    const key = randomUUID();
    await post(key, { amount: 100 });
    const res = await post(key, { amount: 999 });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("idempotency_key_reused");
    expect(await changesFor(key)).toBe(1);
  });

  it("IDEM-02: keys are scoped per caller", async () => {
    const key = randomUUID();
    expect((await post(key, { amount: 100 })).status).toBe(201);
    expect((await post(key, { amount: 100 }, otherAuth)).status).toBe(201);
    expect(await changesFor(key)).toBe(2);
  });

  it("IDEM-02: a failure rolls back the change and the key, so a retry runs", async () => {
    const key = randomUUID();
    const failed = await post(key, { amount: 100, failAfterPost: true });
    expect(failed.status).toBe(500);
    expect(await changesFor(key)).toBe(0);
    const { rowCount } = await h.pool.query("SELECT 1 FROM idempotency_keys WHERE key = $1", [key]);
    expect(rowCount).toBe(0);
  });

  it("IDEM-05: 20 overlapping requests with the same key produce one change", async () => {
    const server = await listen(app);
    try {
      const key = randomUUID();
      const responses = await Promise.all(
        Array.from({ length: 20 }, () =>
          fetch(`${server.url}/test/transfers`, {
            method: "POST",
            headers: {
              authorization: auth,
              "idempotency-key": key,
              "content-type": "application/json",
            },
            body: JSON.stringify({ amount: 100, holdMs: 300 }),
          }).then(async (r) => ({
            status: r.status,
            body: (await r.json()) as { journalId: string },
          })),
        ),
      );
      expect(responses.map((r) => r.status)).toEqual(Array(20).fill(201));
      expect(new Set(responses.map((r) => r.body.journalId)).size).toBe(1);
      expect(await changesFor(key)).toBe(1);
    } finally {
      await server.close();
    }
  });

  it("MONEY-02: a money call with a decimal amount is rejected with 422", async () => {
    const res = await post(randomUUID(), { amount: 10.5 });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("validation_failed");
  });
});
