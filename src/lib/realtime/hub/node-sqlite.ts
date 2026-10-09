import { isAbsolute } from "node:path";
import { SqliteReplayStore, type SqliteDriver } from "./replay-store";

export interface OpenNodeReplayStoreResult {
  store: SqliteReplayStore;
  close(): void;
  checkReadable(): boolean;
}

/**
 * Opens Node's built-in SQLite on an operator-provided persistent volume path.
 * It deliberately refuses relative paths and in-memory databases.
 */
export async function openNodeReplayStore(databasePath: string): Promise<OpenNodeReplayStoreResult> {
  if (!isAbsolute(databasePath) || databasePath === ":memory:") {
    throw new Error("A persistent absolute SQLite path is required");
  }
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(databasePath, { timeout: 5_000 });
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA synchronous = FULL");

  const driver: SqliteDriver = {
    exec(sql) {
      database.exec(sql);
    },
    run(sql, ...values) {
      const result = database.prepare(sql).run(...values);
      return Number(result.changes);
    },
    get(sql, ...values) {
      const result = database.prepare(sql).get(...values);
      return result && typeof result === "object" ? result as Record<string, unknown> : undefined;
    },
  };
  const store = new SqliteReplayStore(driver);
  store.initialize(Math.floor(Date.now() / 1_000));
  return {
    store,
    close: () => database.close(),
    checkReadable: () => store.checkReadable(),
  };
}
