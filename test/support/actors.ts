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

/** A fake 18-digit CLABE for the customer's own bank account. */
export const PAYOUT_CLABE = "012180001234567897";
export const openBody = { payoutClabe: PAYOUT_CLABE };

export async function openAccount(app: Express, auth: string): Promise<AccountView> {
  const res = await request(app)
    .post("/v1/accounts")
    .set("Authorization", auth)
    .set("Idempotency-Key", randomUUID())
    .send(openBody);
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

/** An active account with the given collateral, plus the card token the network uses. */
export async function activeAccount(
  app: Express,
  h: { clock: FixedClock; pool: import("pg").Pool },
  collateral: number,
): Promise<{ auth: string; view: AccountView; cardToken: string }> {
  const auth = await bearer("customer", h.clock);
  const view = await openAccount(app, auth);
  const res = await bankTransfer(app, h.clock, {
    reference: view.collateralReference,
    amount: collateral,
  });
  if (res.body.outcome !== "collateral_confirmed")
    throw new Error(`activation failed: ${res.text}`);
  const { rows } = await h.pool.query<{ token: string }>(
    "SELECT token FROM cards WHERE account_id = $1",
    [view.id],
  );
  return { auth, view, cardToken: rows[0]!.token };
}

export function authorization(args: { cardToken: string; amount: number; networkAuthId?: string }) {
  return {
    networkAuthId: args.networkAuthId ?? `auth_${randomUUID()}`,
    cardToken: args.cardToken,
    amount: args.amount,
    currency: "MXN" as const,
    merchant: { name: "Tienda Demo", mcc: "5411" },
  };
}

export function authorize(app: Express, body: ReturnType<typeof authorization>) {
  return request(app)
    .post("/v1/network/authorizations")
    .set("X-Network-Key", testConfig.networkApiKey)
    .send(body);
}
