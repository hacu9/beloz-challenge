// Test database settings. Locally the Compose Postgres (port 5442); in CI the
// service container (TEST_ADMIN_URL).
export const ADMIN_URL =
  process.env.TEST_ADMIN_URL ?? "postgres://postgres:postgres@localhost:5442/postgres";
export const TEST_DB = "acme_test";
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
export const APP_URL = withDatabase(ADMIN_URL, TEST_DB, {
  name: "acme_app",
  password: APP_PASSWORD,
});
