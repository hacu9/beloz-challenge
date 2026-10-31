# Acme Credit secured card service

- Spec-driven: read `docs/README.md` first. A behaviour change updates `docs/` in the same commit.
- Money is an integer count of MXN centavos: `bigint` in Postgres, safe-integer `number` in TypeScript. Never a float.
- The ledger and the audit log are append-only. A fix is a new entry.
- Every write on an account locks the account row (`SELECT … FOR UPDATE`) inside one transaction.
- All code reads the time from the injectable clock, never `Date.now()` or SQL `now()`.
- Every test names the requirement ID it proves.
