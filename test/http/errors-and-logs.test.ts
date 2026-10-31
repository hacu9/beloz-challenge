import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { createHarness, testConfig } from "../support/harness.js";
import { mountProbeRoutes } from "../support/probe-routes.js";

const h = createHarness();
afterAll(() => h.close());
const app = h.app({ mount: mountProbeRoutes });

describe("error model", () => {
  it("returns JSON 404 for an unknown route", async () => {
    const res = await request(app).get("/nope");
    expect(res.status).toBe(404);
    expect(res.body.error).toMatchObject({ code: "not_found", requestId: expect.any(String) });
  });

  it("returns 400 for malformed JSON", async () => {
    const res = await request(app)
      .post("/test/network")
      .set("content-type", "application/json")
      .send("{not json");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("malformed_request");
  });

  it("returns a generic 500 and never leaks the internal message or stack", async () => {
    const res = await request(app).get("/test/boom");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: { code: "internal_error", message: "internal error", requestId: expect.any(String) },
    });
    expect(JSON.stringify(res.body)).not.toContain("secret internal detail");
  });

  it("health checks the database", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
  });
});

describe("request ID and logs", () => {
  it("OPS-02: echoes a valid X-Request-Id and puts it on the log line", async () => {
    const res = await request(app).get("/health").set("X-Request-Id", "abc-123");
    expect(res.headers["x-request-id"]).toBe("abc-123");
    const line = h.logLines.find((l) => l.requestId === "abc-123");
    expect(line).toMatchObject({ msg: "request", method: "GET", path: "/health", status: 200 });
  });

  it("OPS-02: replaces an unsafe X-Request-Id with a generated one", async () => {
    const res = await request(app)
      .get("/health")
      .set("X-Request-Id", 'bad id "<script>" ' + "x".repeat(80));
    expect(res.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("SEC-06: secrets in logged objects are redacted", () => {
    h.deps.logger.info(
      {
        headers: {
          authorization: "Bearer eyJsecret",
          "x-network-key": testConfig.networkApiKey,
          "x-bank-signature": "t=1,v1=abc",
        },
        password: "hunter2",
        token: "tok_123",
      },
      "redaction probe",
    );
    const line = JSON.stringify(h.logLines.find((l) => l.msg === "redaction probe"));
    expect(line).not.toContain("eyJsecret");
    expect(line).not.toContain(testConfig.networkApiKey);
    expect(line).not.toContain("hunter2");
    expect(line).not.toContain("tok_123");
    expect(line).not.toContain("v1=abc");
  });
});
