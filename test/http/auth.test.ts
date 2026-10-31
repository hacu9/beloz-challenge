import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { signWebhook } from "../../src/fakes/fake-bank.js";
import { issueToken } from "../../src/fakes/fake-login.js";
import { createHarness, testConfig } from "../support/harness.js";
import { mountProbeRoutes } from "../support/probe-routes.js";

const h = createHarness();
afterAll(() => h.close());
const app = h.app({ mount: mountProbeRoutes });
const token = (role: "customer" | "ops", extra: { ttlSeconds?: number; secret?: string } = {}) =>
  issueToken(
    { sub: randomUUID(), role, ...(extra.ttlSeconds ? { ttlSeconds: extra.ttlSeconds } : {}) },
    extra.secret ?? testConfig.jwtSecret,
    h.clock,
  );

describe("SEC-01: customer and ops JWTs", () => {
  it("accepts a valid token and exposes the principal", async () => {
    const res = await request(app)
      .get("/test/customer")
      .set("Authorization", `Bearer ${await token("customer")}`);
    expect(res.status).toBe(200);
    expect(res.body.principal.type).toBe("customer");
  });

  it("rejects a missing token, a wrong secret and garbage with 401", async () => {
    const wrongSecret = await token("customer", { secret: "x".repeat(40) });
    for (const auth of [undefined, `Bearer ${wrongSecret}`, "Bearer not.a.jwt", "Basic abc"]) {
      const req = request(app).get("/test/customer");
      const res = await (auth ? req.set("Authorization", auth) : req);
      expect(res.status, String(auth)).toBe(401);
      expect(res.body.error.code).toBe("unauthorized");
    }
  });

  it("rejects an unsigned token (alg none) with 401", async () => {
    const encode = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const now = Math.floor(h.clock.now().getTime() / 1000);
    const unsigned = `${encode({ alg: "none" })}.${encode({
      sub: randomUUID(),
      role: "ops",
      iss: "fake-login",
      aud: "acme-card",
      exp: now + 60,
    })}.`;
    const res = await request(app).get("/test/ops").set("Authorization", `Bearer ${unsigned}`);
    expect(res.status).toBe(401);
  });

  it("OPS-01: expiry follows the injected clock", async () => {
    const t = await token("customer", { ttlSeconds: 60 });
    expect(
      (await request(app).get("/test/customer").set("Authorization", `Bearer ${t}`)).status,
    ).toBe(200);
    h.clock.advanceMs(61_000);
    expect(
      (await request(app).get("/test/customer").set("Authorization", `Bearer ${t}`)).status,
    ).toBe(401);
  });

  it("rejects the wrong role with 403", async () => {
    const res = await request(app)
      .get("/test/ops")
      .set("Authorization", `Bearer ${await token("customer")}`);
    expect(res.status).toBe(403);
  });
});

describe("SEC-03: card network API key", () => {
  it("accepts the right key and rejects a missing or wrong key", async () => {
    expect(
      (await request(app).post("/test/network").set("X-Network-Key", testConfig.networkApiKey))
        .status,
    ).toBe(200);
    expect((await request(app).post("/test/network")).status).toBe(401);
    expect((await request(app).post("/test/network").set("X-Network-Key", "nope")).status).toBe(
      401,
    );
  });
});

describe("SEC-04: bank webhook signature", () => {
  const body = { type: "deposit.confirmed", bankTxnId: "bt-1", amount: 50_000 };

  it("accepts a valid signature over the raw body", async () => {
    const { payload, headers } = signWebhook(body, testConfig.bankWebhookSecret, h.clock);
    const res = await request(app).post("/test/bank").set(headers).send(payload);
    expect(res.status).toBe(200);
    expect(res.body.body).toEqual(body);
  });

  it("rejects a tampered body", async () => {
    const { headers } = signWebhook(body, testConfig.bankWebhookSecret, h.clock);
    const tampered = JSON.stringify({ ...body, amount: 5_000_000 });
    expect((await request(app).post("/test/bank").set(headers).send(tampered)).status).toBe(401);
  });

  it("rejects the same body re-serialised with different bytes", async () => {
    const { payload, headers } = signWebhook(body, testConfig.bankWebhookSecret, h.clock);
    const reformatted = JSON.stringify(JSON.parse(payload), null, 2);
    expect((await request(app).post("/test/bank").set(headers).send(reformatted)).status).toBe(401);
  });

  it("rejects a wrong secret and a missing header", async () => {
    const { payload, headers } = signWebhook(body, "y".repeat(40), h.clock);
    expect((await request(app).post("/test/bank").set(headers).send(payload)).status).toBe(401);
    expect(
      (await request(app).post("/test/bank").set("content-type", "application/json").send(payload))
        .status,
    ).toBe(401);
  });

  it("rejects a replay outside the 5 minute window", async () => {
    const { payload, headers } = signWebhook(body, testConfig.bankWebhookSecret, h.clock);
    h.clock.advanceMs(301_000);
    expect((await request(app).post("/test/bank").set(headers).send(payload)).status).toBe(401);
  });
});
