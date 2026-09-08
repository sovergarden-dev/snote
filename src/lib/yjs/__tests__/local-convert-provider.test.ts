import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { bytesToBase64 } from "../base64";
import { LocalConvertProvider } from "../local-convert-provider";

describe("LocalConvertProvider", () => {
  it("hydrates from a prefetched snapshot and never touches notes table writes", async () => {
    const doc = new Y.Doc();
    const source = new Y.Doc();
    source.getText("content").insert(0, "from lno");
    const onFirstPersist = vi.fn();
    const provider = new LocalConvertProvider("daily", doc, onFirstPersist);
    const events: string[] = [];
    provider.onSyncEvent((event) => events.push(event.type));

    await provider.connect(
      { name: "Otter", color: "#000" },
      { prefetchedYdocState: bytesToBase64(Y.encodeStateAsUpdate(source)), rowExists: true },
    );

    expect(doc.getText("content").toString()).toBe("from lno");
    expect(onFirstPersist).not.toHaveBeenCalled();
    expect(provider.getPendingBytes()).toBeGreaterThan(0);
    expect(events).not.toContain("synced-durable");
    expect(provider.hasUnflushedLocalChanges()).toBe(true);

    const early = new Y.Doc();
    const earlyPersist = vi.fn();
    const earlyProvider = new LocalConvertProvider("early", early, earlyPersist);
    early.getText("content").insert(0, "before connect");
    expect(earlyPersist).not.toHaveBeenCalled();
    await earlyProvider.connect({ name: "Otter", color: "#000" });
    expect(earlyPersist).not.toHaveBeenCalled();
    await earlyProvider.destroy();

    doc.getText("content").insert(8, "!");
    expect(onFirstPersist).toHaveBeenCalledOnce();
    doc.getText("content").insert(9, "!");
    expect(onFirstPersist).toHaveBeenCalledOnce();

    provider.emitConvertError("network lost");
    expect(events).toContain("error");
    expect(events).not.toContain("synced-durable");
    await provider.destroy();
  });
});
