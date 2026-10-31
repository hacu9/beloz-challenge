import type pg from "pg";

export const APP_ROLE = "acme_app";

// Creates the least-privilege login role the app connects with. The migration
// grants it SELECT/INSERT only on the ledger and audit tables. Runs as the
// database owner, before the migrations. In AWS this role is created once by
// the same step, from a Secrets Manager password.
export async function ensureAppRole(owner: pg.ClientBase, password: string): Promise<void> {
  const { rowCount } = await owner.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [APP_ROLE]);
  if (rowCount === 0) {
    await owner.query(
      `CREATE ROLE ${APP_ROLE} LOGIN PASSWORD ${owner.escapeLiteral(password)} NOSUPERUSER NOCREATEDB NOCREATEROLE`,
    );
  }
}
