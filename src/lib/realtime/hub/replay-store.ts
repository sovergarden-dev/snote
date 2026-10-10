import { encodeBase64Url } from "../protocol";

export const HUB_REPLAY_TABLE = "hub_ticket_replay";
export const HUB_REPLAY_MAINTENANCE_TABLE = "hub_replay_maintenance";
export const REPLAY_RETENTION_SECONDS = 120;
export const REPLAY_CLEANUP_INTERVAL_SECONDS = 10 * 60;
export const MAX_REPLAY_CLEANUP_BATCH_SIZE = 100;

type SqlValue = string | number;

export interface SqliteDriver {
  exec(sql: string): void;
  run(sql: string, ...values: SqlValue[]): number;
  get(sql: string, ...values: SqlValue[]): Record<string, unknown> | undefined;
}

export interface ReplayStore {
  consumeJti(jti: string, ticketExpSeconds: number, nowSeconds: number): Promise<boolean>;
}

async function hashJti(jti: string): Promise<string> {
  const input = new TextEncoder().encode(jti);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  return encodeBase64Url(digest);
}

function assertUnixSeconds(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${name}`);
}

/**
 * Shared atomic replay store for Node SQLite and Durable Object SQLite.
 * The adapter supplies only the SQLite I/O primitives; this class owns the
 * schema, retention, cleanup cadence, batch bound, and uniqueness semantics.
 */
export class SqliteReplayStore implements ReplayStore {
  private initialized = false;

  constructor(private readonly driver: SqliteDriver) {}

  initialize(nowSeconds: number): void {
    assertUnixSeconds(nowSeconds, "clock value");
    if (this.initialized) return;

    this.driver.exec(
      `CREATE TABLE IF NOT EXISTS ${HUB_REPLAY_TABLE} (
        jti_sha256 TEXT NOT NULL UNIQUE,
        expires_at INTEGER NOT NULL
      ) STRICT`,
    );
    this.driver.exec(
      `CREATE TABLE IF NOT EXISTS ${HUB_REPLAY_MAINTENANCE_TABLE} (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        last_cleanup_at INTEGER NOT NULL
      ) STRICT`,
    );
    this.driver.run(
      `INSERT INTO ${HUB_REPLAY_MAINTENANCE_TABLE} (singleton, last_cleanup_at)
       VALUES (1, ?) ON CONFLICT(singleton) DO NOTHING`,
      nowSeconds - REPLAY_CLEANUP_INTERVAL_SECONDS,
    );
    this.initialized = true;
  }

  async consumeJti(jti: string, ticketExpSeconds: number, nowSeconds: number): Promise<boolean> {
    if (typeof jti !== "string" || jti.length === 0 || jti.length > 256) throw new Error("Invalid JTI");
    assertUnixSeconds(ticketExpSeconds, "ticket expiry");
    assertUnixSeconds(nowSeconds, "clock value");
    const expiresAt = ticketExpSeconds + REPLAY_RETENTION_SECONDS;
    assertUnixSeconds(expiresAt, "replay expiry");

    const digest = await hashJti(jti);
    this.initialize(nowSeconds);
    this.cleanupExpiredBatch(nowSeconds);

    const inserted = this.driver.get(
      `INSERT INTO ${HUB_REPLAY_TABLE} (jti_sha256, expires_at)
       VALUES (?, ?) ON CONFLICT(jti_sha256) DO NOTHING
       RETURNING jti_sha256`,
      digest,
      expiresAt,
    );
    return inserted?.jti_sha256 === digest;
  }

  /**
   * Readiness probes may call this after startup. It is deliberately SELECT-only:
   * it never initializes schema, inserts a probe JTI, or changes SQLite state.
   */
  checkReadable(): boolean {
    try {
      const maintenance = this.driver.get(
        `SELECT last_cleanup_at FROM ${HUB_REPLAY_MAINTENANCE_TABLE} WHERE singleton = 1`,
      );
      if (!maintenance || !Number.isSafeInteger(maintenance.last_cleanup_at)) return false;
      const replay = this.driver.get(
        `SELECT jti_sha256, expires_at FROM ${HUB_REPLAY_TABLE} ORDER BY expires_at LIMIT 1`,
      );
      return replay === undefined || (
        typeof replay.jti_sha256 === "string" && Number.isSafeInteger(replay.expires_at)
      );
    } catch {
      return false;
    }
  }

  private cleanupExpiredBatch(nowSeconds: number): void {
    const eligible = this.driver.get(
      `UPDATE ${HUB_REPLAY_MAINTENANCE_TABLE}
       SET last_cleanup_at = ?
       WHERE singleton = 1 AND last_cleanup_at <= ?
       RETURNING singleton`,
      nowSeconds,
      nowSeconds - REPLAY_CLEANUP_INTERVAL_SECONDS,
    );
    if (eligible?.singleton !== 1) return;

    this.driver.run(
      `DELETE FROM ${HUB_REPLAY_TABLE}
       WHERE jti_sha256 IN (
         SELECT jti_sha256 FROM ${HUB_REPLAY_TABLE}
         WHERE expires_at < ?
         ORDER BY expires_at
         LIMIT ${MAX_REPLAY_CLEANUP_BATCH_SIZE}
       )`,
      nowSeconds,
    );
  }
}
