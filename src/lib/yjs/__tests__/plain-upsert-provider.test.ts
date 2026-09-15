import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { CapabilityApiError } from "@/lib/capability/client";
import { bytesToBase64 } from "../base64";
import { PlainUpsertProvider } from "../plain-upsert-provider";

describe("PlainUpsertProvider", () => {
  beforeEach(() => {
    localStorage.setItem("syrin:yjs-snapshot-debounce-ms", "0");
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
  });

  it("persists local edits through Edge upsert and never converts", async () => {
    const doc = new Y.Doc();
    const source = new Y.Doc();
    source.getText("content").insert(0, "from lno");
    const upsert = vi.fn(async () => ({ noteId: "n", created: true }));
    const onManaged = vi.fn();
    const provider = new PlainUpsertProvider("daily", doc, upsert, onManaged);
    const events: string[] = [];
    provider.onSyncEvent((event) => events.push(event.type));

    await provider.connect(
      { name: "Otter", color: "#000" },
      { prefetchedYdocState: bytesToBase64(Y.encodeStateAsUpdate(source)), rowExists: true },
    );
    expect(doc.getText("content").toString()).toBe("from lno");
    expect(upsert).not.toHaveBeenCalled();

    doc.getText("content").insert(8, "!");
    await vi.runOnlyPendingTimersAsync();
    await Promise.resolve();

    expect(upsert).toHaveBeenCalledOnce();
    expect(upsert.mock.calls[0]?.[0]).toMatchObject({
      slug: "daily",
      content: "from lno!",
      isEncrypted: false,
      salt: null,
      check: null,
      iterations: null,
    });
    expect(events).toContain("synced-durable");
    expect(onManaged).not.toHaveBeenCalled();
    await provider.destroy();
  });

  it("surfaces capability_managed through onManaged instead of retrying notes writes", async () => {
    const doc = new Y.Doc();
    const upsert = vi.fn(async () => {
      throw new CapabilityApiError("capability managed", 409, null, "capability_managed");
    });
    const onManaged = vi.fn();
    const provider = new PlainUpsertProvider("daily", doc, upsert, onManaged);
    await provider.connect({ name: "Otter", color: "#000" });
    doc.getText("content").insert(0, "x");
    await vi.runOnlyPendingTimersAsync();
    await Promise.resolve();
    expect(onManaged).toHaveBeenCalledOnce();
    await provider.destroy();
  });
});
