import { randomUUID } from "node:crypto";
import type { Express } from "express";
import request from "supertest";
import { signWebhook, transferReceived, type TransferArgs } from "../../src/fakes/fake-bank.js";
import { issueToken } from "../../src/fakes/fake-login.js";
import type { AccountView } from "../../src/modules/accounts/accounts.js";
import type { FixedClock } from "../../src/platform/clock.js";
import { testConfig } from "./harness.js";

export async function bearer(role: "customer" | "ops", clock: FixedClock, sub = randomUUID()) {
  return `Bearer ${await issueToken({ sub, role }, testConfig.jwtSecret, clock)}`;
}

export async function openAccount(app: Express, auth: string): Promise<AccountView> {
  const res = await request(app)
    .post("/v1/accounts")
    .set("Authorization", auth)
    .set("Idempotency-Key", randomUUID())
    .send({});
  if (res.status !== 201) throw new Error(`open account failed: ${res.status} ${res.text}`);
  return res.body as AccountView;
}

export function bankTransfer(app: Express, clock: FixedClock, args: TransferArgs) {
  const { payload, headers } = signWebhook(
    transferReceived(args),
    testConfig.bankWebhookSecret,
    clock,
  );
  return request(app).post("/v1/bank/webhooks").set(headers).send(payload);
}

export async function getAccount(app: Express, auth: string, id: string) {
  return request(app).get(`/v1/accounts/${id}`).set("Authorization", auth);
}
