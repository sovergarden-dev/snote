import { encodeBase64Url, decodeBase64Url } from "@/lib/realtime/protocol";

export type RealtimeOutboxUpdate = {
  slug: string;
  generation: number;
  updateId: string;
  update: Uint8Array;
  createdAt: number;
};

type StoredRealtimeOutboxUpdate = Omit<RealtimeOutboxUpdate, "update"> & {
  update: string;
};

const DEFAULT_DB_NAME = "snote-realtime-outbox";
const STORE = "updates";
const DB_VERSION = 1;

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"));
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
  });
}

export class RealtimeOutbox {
  private readonly database: Promise<IDBDatabase>;

  constructor(private readonly databaseName = DEFAULT_DB_NAME) {
    this.database = new Promise((resolve, reject) => {
      const request = indexedDB.open(databaseName, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (db.objectStoreNames.contains(STORE)) return;
        const store = db.createObjectStore(STORE, {
          keyPath: ["slug", "generation", "updateId"],
        });
        store.createIndex(
          "slug_generation_created",
          ["slug", "generation", "createdAt"],
          { unique: false },
        );
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB unavailable"));
      request.onblocked = () => reject(new Error("IndexedDB upgrade blocked"));
    });
  }

  async enqueue(row: RealtimeOutboxUpdate): Promise<void> {
    if (!row.slug || !Number.isSafeInteger(row.generation) || row.generation < 1) {
      throw new Error("invalid realtime outbox authority");
    }
    if (!/^[A-Za-z0-9_-]{16,128}$/u.test(row.updateId) || row.update.byteLength === 0) {
      throw new Error("invalid realtime outbox update");
    }
    const db = await this.database;
    const transaction = db.transaction(STORE, "readwrite");
    const done = transactionDone(transaction);
    const store = transaction.objectStore(STORE);
    const key: [string, number, string] = [row.slug, row.generation, row.updateId];
    const existing = await requestResult(store.get(key));
    if (!existing) {
      const stored: StoredRealtimeOutboxUpdate = {
        ...row,
        update: encodeBase64Url(row.update),
      };
      store.add(stored);
    }
    await done;
  }

  async list(slug: string, generation: number, limit = 256): Promise<RealtimeOutboxUpdate[]> {
    const db = await this.database;
    const transaction = db.transaction(STORE, "readonly");
    const done = transactionDone(transaction);
    const index = transaction.objectStore(STORE).index("slug_generation_created");
    const range = IDBKeyRange.bound(
      [slug, generation, 0],
      [slug, generation, Number.MAX_SAFE_INTEGER],
    );
    const rows = (await requestResult(index.getAll(range, Math.max(0, Math.min(limit, 4096))))) as StoredRealtimeOutboxUpdate[];
    await done;
    return rows
      .sort((a, b) => a.createdAt - b.createdAt || a.updateId.localeCompare(b.updateId))
      .map(({ update, ...row }) => ({ ...row, update: decodeBase64Url(update) }));
  }

  async acknowledge(slug: string, generation: number, updateIds: string[]): Promise<void> {
    if (updateIds.length === 0) return;
    const db = await this.database;
    const transaction = db.transaction(STORE, "readwrite");
    const done = transactionDone(transaction);
    const store = transaction.objectStore(STORE);
    for (const updateId of new Set(updateIds)) {
      store.delete([slug, generation, updateId]);
    }
    await done;
  }

  close(): void {
    void this.database.then((db) => db.close()).catch(() => {});
  }
}
