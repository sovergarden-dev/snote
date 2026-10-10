import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeBase64Url } from "../../protocol";
import { bunSqliteDriver } from "./bun-sqlite-driver";
import {
  HUB_REPLAY_MAINTENANCE_TABLE,
  HUB_REPLAY_TABLE,
  MAX_REPLAY_CLEANUP_BATCH_SIZE,
  SqliteReplayStore,
} from "../replay-store";

const NOW = 1_800_000_000;
const databases: Database[] = [];

function createStore(): { database: Database; store: SqliteReplayStore; driver: ReturnType<typeof bunSqliteDriver> } {
  const database = new Database(":memory:");
  databases.push(database);
  const driver = bunSqliteDriver(database);
  return { database, driver, store: new SqliteReplayStore(driver) };
}

function jti(seed: number): string {
  return encodeBase64Url(new Uint8Array(16).fill(seed));
}

function hash(seed: number): string {
  return encodeBase64Url(new Uint8Array(32).fill(seed));
}

afterEach(() => {
  while (databases.length > 0) databases.pop()?.close();
});

describe("durable replay store", () => {
  it("atomically consumes the same JTI once and stores only its SHA-256 digest", async () => {
    const { database, store } = createStore();
    const rawJti = jti(7);
    const outcomes = await Promise.all(
      Array.from({ length: 24 }, () => store.consumeJti(rawJti, NOW + 300, NOW)),
    );

    expect(outcomes.filter(Boolean)).toHaveLength(1);
    const rows = database.query(`SELECT jti_sha256, expires_at FROM ${HUB_REPLAY_TABLE}`).all() as {
      jti_sha256: string;
      expires_at: number;
    }[];
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rawJti)));
    expect(rows).toEqual([{ jti_sha256: encodeBase64Url(digest), expires_at: NOW + 420 }]);
    expect(rows[0]?.jti_sha256).not.toBe(rawJti);
  });

  it("keeps a JTI through the inclusive exp+120 boundary, then permits cleanup after it", async () => {
    const { database, driver, store } = createStore();
    const rawJti = jti(8);
    await store.consumeJti(rawJti, NOW, NOW);
    driver.run(
      `UPDATE ${HUB_REPLAY_MAINTENANCE_TABLE} SET last_cleanup_at = ? WHERE singleton = 1`,
      NOW + 120 - 600,
    );

    expect(await store.consumeJti(rawJti, NOW, NOW + 120)).toBe(false);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rawJti)));
    const digestText = encodeBase64Url(digest);
    expect(database.query(`SELECT 1 AS present FROM ${HUB_REPLAY_TABLE} WHERE jti_sha256 = ?`).get(digestText)).toBeTruthy();

    driver.run(
      `UPDATE ${HUB_REPLAY_MAINTENANCE_TABLE} SET last_cleanup_at = ? WHERE singleton = 1`,
      NOW + 121 - 600,
    );
    await store.consumeJti(jti(9), NOW + 900, NOW + 121);
    expect(database.query(`SELECT 1 AS present FROM ${HUB_REPLAY_TABLE} WHERE jti_sha256 = ?`).get(digestText)).toBeNull();
  });

  it("runs at most one bounded cleanup per ten minutes, only during a handshake", async () => {
    const { database, store } = createStore();
    await store.consumeJti(jti(10), NOW + 600, NOW);
    const seedRows = Array.from({ length: MAX_REPLAY_CLEANUP_BATCH_SIZE + 1 }, (_, index) =>
      database.query(`INSERT INTO ${HUB_REPLAY_TABLE} (jti_sha256, expires_at) VALUES (?, ?)`)
        .run(hash(index + 20), NOW + 5),
    );
    expect(seedRows).toHaveLength(MAX_REPLAY_CLEANUP_BATCH_SIZE + 1);

    await store.consumeJti(jti(11), NOW + 1_600, NOW + 600);
    const afterFirstBatch = database.query(`SELECT COUNT(*) AS count FROM ${HUB_REPLAY_TABLE} WHERE expires_at < ?`).get(NOW + 600) as { count: number };
    expect(afterFirstBatch.count).toBe(1);

    await store.consumeJti(jti(12), NOW + 1_601, NOW + 601);
    const beforeWindow = database.query(`SELECT COUNT(*) AS count FROM ${HUB_REPLAY_TABLE} WHERE expires_at < ?`).get(NOW + 601) as { count: number };
    expect(beforeWindow.count).toBe(1);

    await store.consumeJti(jti(13), NOW + 2_200, NOW + 1_200);
    const afterNextWindow = database.query(`SELECT COUNT(*) AS count FROM ${HUB_REPLAY_TABLE} WHERE expires_at < ?`).get(NOW + 1_200) as { count: number };
    expect(afterNextWindow.count).toBe(0);
  });

  it("can perform a read-only readiness check without changing SQLite rows", () => {
    const { database, store } = createStore();
    store.initialize(NOW);
    const before = database.query("SELECT total_changes() AS changes").get() as { changes: number };

    expect(store.checkReadable()).toBe(true);

    const after = database.query("SELECT total_changes() AS changes").get() as { changes: number };
    expect(after.changes).toBe(before.changes);
  });

  it("reports unreadable when a required replay table is missing", () => {
    const { database, store } = createStore();
    store.initialize(NOW);
    database.exec(`DROP TABLE ${HUB_REPLAY_TABLE}`);

    expect(store.checkReadable()).toBe(false);
  });

  it("retains consumed ticket JTI after closing and reopening the persistent SQLite file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "snote-hub-replay-store-"));
    const path = join(directory, "replay.sqlite");
    try {
      const firstDatabase = new Database(path);
      firstDatabase.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
      const firstStore = new SqliteReplayStore(bunSqliteDriver(firstDatabase));
      expect(await firstStore.consumeJti(jti(15), NOW + 300, NOW)).toBe(true);
      firstDatabase.close();

      const reopenedDatabase = new Database(path);
      const reopenedStore = new SqliteReplayStore(bunSqliteDriver(reopenedDatabase));
      expect(await reopenedStore.consumeJti(jti(15), NOW + 300, NOW)).toBe(false);
      const rows = reopenedDatabase.query(`SELECT COUNT(*) AS count FROM ${HUB_REPLAY_TABLE}`).get() as { count: number };
      expect(rows.count).toBe(1);
      reopenedDatabase.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("propagates storage failures so the caller can fail closed", async () => {
    const { driver } = createStore();
    const failingStore = new SqliteReplayStore({
      ...driver,
      run() {
        throw new Error("synthetic sqlite failure");
      },
    });
    let failure: unknown;
    try {
      await failingStore.consumeJti(jti(14), NOW + 300, NOW);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
  });
});
