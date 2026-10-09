import { Database } from "bun:sqlite";
import type { SqliteDriver } from "../replay-store";

export function bunSqliteDriver(database: Database): SqliteDriver {
  return {
    exec(sql) {
      database.exec(sql);
    },
    run(sql, ...values) {
      return Number(database.query(sql).run(...values).changes);
    },
    get(sql, ...values) {
      const result = database.query(sql).get(...values);
      return result && typeof result === "object" ? result as Record<string, unknown> : undefined;
    },
  };
}
