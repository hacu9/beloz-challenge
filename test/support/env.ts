// Test database settings. Locally the Compose Postgres (port 5442); in CI the
// service container (TEST_ADMIN_URL).
export const ADMIN_URL =
  process.env.TEST_ADMIN_URL ?? "postgres://postgres:postgres@localhost:5442/postgres";
export const TEST_DB = "acme_test";
// A migrated copy with no traffic, for checks that take table-wide locks
// (TRUNCATE ... CASCADE) and would deadlock with tests running in parallel.
export const ISOLATED_DB = "acme_test_isolated";
// Same password as Compose: the acme_app role is cluster-wide.
export const APP_PASSWORD = "acme_app_local";

function withDatabase(url: string, database: string, user?: { name: string; password: string }) {
  const u = new URL(url);
  u.pathname = `/${database}`;
  if (user) {
    u.username = user.name;
    u.password = user.password;
  }
  return u.toString();
}

export const OWNER_URL = withDatabase(ADMIN_URL, TEST_DB);
export const ISOLATED_OWNER_URL = withDatabase(ADMIN_URL, ISOLATED_DB);
export const APP_URL = withDatabase(ADMIN_URL, TEST_DB, {
  name: "acme_app",
  password: APP_PASSWORD,
});
