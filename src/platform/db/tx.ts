import type pg from "pg";

export type Tx = pg.PoolClient;

// One DB transaction at READ COMMITTED (decision P6). Writers serialise on the
// account row with SELECT ... FOR UPDATE; lock_timeout keeps a stuck lock from
// holding a request open forever.
export async function withTx<T>(pool: pg.Pool, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
