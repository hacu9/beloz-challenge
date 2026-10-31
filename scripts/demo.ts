// OPS-05: the main flow end to end, against the running Compose stack.
//
//   docker compose up -d --build   (DOCKER_BUILDKIT=0 if buildx is missing)
//   npm run demo
//
// It talks HTTP to the API as the customer, the card network, the bank and
// ops, and runs the scheduled jobs the way production does: one container per
// run (`docker compose run --rm jobs <job>`). It checks every number it
// prints and exits non-zero on the first surprise.
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { signWebhook, payoutResult, transferReceived } from "../src/fakes/fake-bank.js";
import { issueToken } from "../src/fakes/fake-login.js";
import { SystemClock } from "../src/platform/clock.js";
import { formatMxn } from "../src/platform/money.js";

if (existsSync(".env")) process.loadEnvFile(".env");
process.loadEnvFile(".env.example"); // fills only what .env did not set

const API = process.env.DEMO_API_URL ?? "http://localhost:3080";
const clock = new SystemClock();
const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is not set`);
  return v;
};

type Json = Record<string, unknown>;
let stepNo = 0;

function step(title: string): void {
  stepNo += 1;
  console.log(`\n${String(stepNo).padStart(2, " ")}. ${title}`);
}

function expectEq(label: string, actual: unknown, expected: unknown, money = true): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  const show = (v: unknown) =>
    money && typeof v === "number" ? `${formatMxn(v)} MXN` : JSON.stringify(v);
  console.log(
    `    ${ok ? "ok  " : "FAIL"} ${label}: ${show(actual)}${ok ? "" : ` (expected ${show(expected)})`}`,
  );
  if (!ok) {
    console.error("\nDemo stopped: unexpected value.");
    process.exit(1);
  }
}

async function call(method: string, path: string, headers: Record<string, string>, body?: unknown) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
  const json = (await res.json()) as Json;
  if (res.status >= 400) {
    console.error(`${method} ${path} -> ${res.status} ${JSON.stringify(json)}`);
    process.exit(1);
  }
  return json;
}

function job(name: string): void {
  const r = spawnSync("docker", ["compose", "run", "--rm", "-T", "jobs", name], {
    encoding: "utf8",
  });
  const line = r.stdout.trim().split("\n").at(-1) ?? "";
  console.log(`    job ${name}: exit ${r.status} ${line.slice(0, 160)}`);
  if (r.status !== 0) {
    console.error(r.stderr);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const customerId = randomUUID();
  const customer = {
    authorization: `Bearer ${await issueToken({ sub: customerId, role: "customer" }, env("JWT_SECRET"), clock)}`,
  };
  const ops = {
    authorization: `Bearer ${await issueToken({ sub: randomUUID(), role: "ops" }, env("JWT_SECRET"), clock)}`,
  };
  const network = { "x-network-key": env("NETWORK_API_KEY") };
  const idem = () => ({ "idempotency-key": randomUUID() });
  const bank = (event: unknown) => {
    const { payload, headers } = signWebhook(event, env("BANK_WEBHOOK_SECRET"), clock);
    return call("POST", "/v1/bank/webhooks", headers, payload);
  };
  const account = (id: string) => call("GET", `/v1/accounts/${id}`, customer);

  console.log(`Acme Credit demo against ${API}`);
  expectEq("health", await call("GET", "/health", {}), { status: "ok" });

  step("Customer opens an account");
  const opened = await call(
    "POST",
    "/v1/accounts",
    { ...customer, ...idem() },
    {
      payoutClabe: "012180001234567897",
    },
  );
  const id = opened.id as string;
  expectEq("status", opened.status, "pending_collateral");
  expectEq("card", opened.card, { last4: (opened.card as Json).last4, status: "inactive" });

  step("Bank: 5,000.00 MXN arrives at the collateral reference");
  const dep = await bank(
    transferReceived({ reference: opened.collateralReference as string, amount: 500_000 }),
  );
  expectEq("outcome", dep.outcome, "collateral_confirmed");
  let a = await account(id);
  expectEq("status", a.status, "active");
  expectEq("credit limit (1:1)", a.creditLimit, 500_000);

  // The card token is only known to the card network; the demo reads it the
  // way the issuer processor would hand it over.
  const token = spawnSync(
    "docker",
    [
      "compose",
      "exec",
      "-T",
      "db",
      "psql",
      "-U",
      "postgres",
      "-d",
      "acme",
      "-tAc",
      `SELECT token FROM cards WHERE account_id = '${id}'`,
    ],
    { encoding: "utf8" },
  ).stdout.trim();

  step("Network: purchase of 1,200.00 MXN is authorized, then captured");
  const auth1 = await call("POST", "/v1/network/authorizations", network, {
    networkAuthId: `auth_${randomUUID()}`,
    cardToken: token,
    amount: 120_000,
    currency: "MXN",
    merchant: { name: "Super Demo", mcc: "5411" },
  });
  expectEq("approved", auth1.approved, true);
  await call("POST", "/v1/network/captures", network, {
    networkCaptureId: `cap_${randomUUID()}`,
    networkAuthId: auth1.networkAuthId,
    cardToken: token,
    amount: 120_000,
    currency: "MXN",
  });
  a = await account(id);
  expectEq("posted debt", a.postedDebt, 120_000);
  expectEq("available", a.availableCredit, 380_000);

  step("Network: a purchase above available credit is declined");
  const big = await call("POST", "/v1/network/authorizations", network, {
    networkAuthId: `auth_${randomUUID()}`,
    cardToken: token,
    amount: 400_000,
    currency: "MXN",
  });
  expectEq("decision", [big.approved, big.declineReason], [false, "insufficient_credit"]);

  step("Network: 20 purchases of 300.00 MXN hit the card at the same time");
  const burst = await Promise.all(
    Array.from({ length: 20 }, () =>
      call("POST", "/v1/network/authorizations", network, {
        networkAuthId: `auth_${randomUUID()}`,
        cardToken: token,
        amount: 30_000,
        currency: "MXN",
      }),
    ),
  );
  expectEq("approved (12 fit in 3,800.00)", burst.filter((b) => b.approved).length, 12, false);
  a = await account(id);
  expectEq("held", a.heldTotal, 360_000);
  for (const b of burst.filter((x) => x.approved)) {
    await call("POST", `/v1/network/authorizations/${b.networkAuthId as string}/reversal`, network);
  }
  a = await account(id);
  expectEq("held after reversals", a.heldTotal, 0);

  step("Bank: customer repays 1,500.00 MXN (300.00 more than owed)");
  await bank(transferReceived({ reference: opened.repaymentReference as string, amount: 150_000 }));
  a = await account(id);
  expectEq("posted debt", a.postedDebt, 0);
  expectEq("credit balance", a.creditBalance, 30_000);
  expectEq("available (credit never raises it)", a.availableCredit, 500_000);

  step("Network: a 100.00 MXN force-post capture nets against the credit");
  await call("POST", "/v1/network/captures", network, {
    networkCaptureId: `cap_${randomUUID()}`,
    cardToken: token,
    amount: 10_000,
    currency: "MXN",
  });
  a = await account(id);
  expectEq("posted debt", a.postedDebt, 0);
  expectEq("credit balance", a.creditBalance, 20_000);

  step("Customer closes the account");
  const closing = await call("POST", `/v1/accounts/${id}/close`, { ...customer, ...idem() }, {});
  expectEq("status", closing.status, "closing");
  expectEq("card", (closing.card as Json).status, "blocked");

  step("Job progress-closures: settle (late-capture window is 0 in the demo)");
  job("progress-closures");
  a = await account(id);
  expectEq("status", a.status, "settling");
  const { payouts } = (await call("GET", `/v1/ops/payouts?accountId=${id}`, ops)) as {
    payouts: { id: string; kind: string; amount: number; status: string }[];
  };
  expectEq("payouts", payouts.map((p) => [p.kind, p.amount, p.status]).sort(), [
    ["collateral", 500_000, "requested"],
    ["credit", 20_000, "requested"],
  ]);

  step("Bank: both payouts are confirmed");
  for (const p of payouts) {
    const r = await bank(payoutResult({ payoutId: p.id, result: "completed" }));
    expectEq(`${p.kind} payout`, r.outcome, "payout_result_applied");
  }

  step("Job progress-closures: close");
  job("progress-closures");
  a = await account(id);
  expectEq("status", a.status, "closed");
  expectEq("collateral left", a.creditLimit, 0);
  expectEq("credit left", a.creditBalance, 0);

  step("Job reconcile: ledger sums to zero, every cached balance matches");
  job("reconcile");

  console.log("\nDemo finished: every check passed.");
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
