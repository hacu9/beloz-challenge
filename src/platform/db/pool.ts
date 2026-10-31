import pg from "pg";
import { parsePgInteger } from "../money.js";

const INT8_OID = 20;
const NUMERIC_OID = 1700;

// MONEY-04: int8 and numeric (the type of sum(int8)) come back as exact JS
// integers, or the query throws. The schema has no fractional numeric column.
// The parsers are per pool, so no global pg state changes.
const types: pg.CustomTypesConfig = {
  getTypeParser: ((oid: number, format?: "text" | "binary") => {
    if (oid === INT8_OID || oid === NUMERIC_OID) return parsePgInteger;
    return pg.types.getTypeParser(oid, format) as (value: string) => unknown;
  }) as pg.CustomTypesConfig["getTypeParser"],
};

export type Pool = pg.Pool;
export type Queryable = pg.Pool | pg.PoolClient;

export function createPool(connectionString: string, max = 20): pg.Pool {
  return new pg.Pool({ connectionString, max, types });
}
