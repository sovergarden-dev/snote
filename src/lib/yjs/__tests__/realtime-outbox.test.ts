import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { RealtimeOutbox } from "../realtime-outbox";

const DATABASE = "snote-realtime-outbox-test";

describe("RealtimeOutbox", () => {
  beforeEach(async () => {
    await new Promise<void>((resolve) => {
      const request = indexedDB.deleteDatabase(DATABASE);
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      request.onblocked = () => resolve();
    });
  });

  it("survives reopening after a page reload until explicitly acknowledged", async () => {
    const first = new RealtimeOutbox(DATABASE);
    await first.enqueue({
      slug: "random-test-note",
      generation: 7,
      updateId: "abcdefghijklmnop",
      update: new Uint8Array([1, 2, 3]),
      createdAt: 10,
    });
    first.close();

    const reopened = new RealtimeOutbox(DATABASE);
    await expect(reopened.list("random-test-note", 7)).resolves.toEqual([{
      slug: "random-test-note",
      generation: 7,
      updateId: "abcdefghijklmnop",
      update: new Uint8Array([1, 2, 3]),
      createdAt: 10,
    }]);
    reopened.close();
  });

  it("keeps rows isolated by slug and generation", async () => {
    const outbox = new RealtimeOutbox(DATABASE);
    await outbox.enqueue({
      slug: "random-test-note",
      generation: 7,
      updateId: "abcdefghijklmnop",
      update: new Uint8Array([1]),
      createdAt: 10,
    });
    await outbox.enqueue({
      slug: "random-test-note",
      generation: 8,
      updateId: "qrstuvwxyzABCDEF",
      update: new Uint8Array([2]),
      createdAt: 11,
    });
    await outbox.enqueue({
      slug: "another-test-note",
      generation: 7,
      updateId: "GHIJKLMNOPQRSTUV",
      update: new Uint8Array([3]),
      createdAt: 12,
    });

    expect(await outbox.list("random-test-note", 7)).toHaveLength(1);
    expect(await outbox.list("random-test-note", 8)).toHaveLength(1);
    expect(await outbox.list("another-test-note", 7)).toHaveLength(1);
    outbox.close();
  });
});
