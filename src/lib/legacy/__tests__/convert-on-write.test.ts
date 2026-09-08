import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  consumeConvertSeed,
  convertPlainNoteOnWrite,
  resetConvertOnWriteForTests,
} from "../convert-on-write";

function memoryRecoveryStore() {
  let value: unknown = null;
  return {
    load: vi.fn(() => value),
    save: vi.fn((_slug: string, next: unknown) => { value = next; }),
    clear: vi.fn(() => { value = null; }),
  };
}

function memoryOwnerStore() {
  let value: string | null = null;
  return {
    load: vi.fn(() => value),
    save: vi.fn((_slug: string, owner: string) => { value = owner; }),
    clear: vi.fn(() => { value = null; }),
  };
}

afterEach(() => {
  resetConvertOnWriteForTests();
});

describe("W1 convert-on-write", () => {
  it("imports an existing legacy note onto the same slug, not a duplicate locator", async () => {
    const doc = new Y.Doc();
    doc.getText("content").insert(0, "keep me");
    const api = {
      importLegacyNote: vi.fn(async (_body: unknown, owner: string) => ({
        capabilities: { owner },
      })),
      createNote: vi.fn(),
    };

    const path = await convertPlainNoteOnWrite({
      slug: "daily",
      doc,
      source: {
        slug: "daily",
        content: "keep me",
        ydocState: "",
        isEncrypted: false,
        salt: null,
        check: null,
        iterations: null,
      },
      api,
      recoveryStore: memoryRecoveryStore(),
    });

    expect(api.createNote).not.toHaveBeenCalled();
    expect(api.importLegacyNote).toHaveBeenCalledOnce();
    const [body, owner] = api.importLegacyNote.mock.calls[0] as [
      { slug: string },
      string,
    ];
    expect(body.slug).toBe("daily");
    expect(path).toBe(`/daily#owner=${owner}`);
    expect(consumeConvertSeed("daily")).toBeInstanceOf(Uint8Array);
  });

  it("mints an empty new note through create, not import-legacy", async () => {
    const doc = new Y.Doc();
    const api = {
      importLegacyNote: vi.fn(),
      createNote: vi.fn(async (_slug: string, owner: string) => ({
        capabilities: { owner },
      })),
    };

    const path = await convertPlainNoteOnWrite({
      slug: "fresh",
      doc,
      source: null,
      api,
      pendingOwnerStore: memoryOwnerStore(),
    });

    expect(api.importLegacyNote).not.toHaveBeenCalled();
    expect(api.createNote).toHaveBeenCalledOnce();
    expect(api.createNote.mock.calls[0][0]).toBe("fresh");
    const owner = api.createNote.mock.calls[0][1] as string;
    expect(path).toBe(`/fresh#owner=${owner}`);
  });

  it("single-flights overlapping converts for the same slug", async () => {
    const doc = new Y.Doc();
    doc.getText("content").insert(0, "once");
    let release!: (owner: string) => void;
    const api = {
      importLegacyNote: vi.fn((_body: unknown, owner: string) => new Promise<{
        capabilities: { owner: string };
      }>((resolve) => {
        release = (nextOwner) => resolve({ capabilities: { owner: nextOwner } });
        void owner;
      })),
      createNote: vi.fn(),
    };
    const source = {
      slug: "daily",
      content: "once",
      ydocState: "",
      isEncrypted: false,
      salt: null as string | null,
      check: null as string | null,
      iterations: null as number | null,
    };

    const first = convertPlainNoteOnWrite({
      slug: "daily",
      doc,
      source,
      api,
      recoveryStore: memoryRecoveryStore(),
    });
    const second = convertPlainNoteOnWrite({
      slug: "daily",
      doc,
      source,
      api,
      recoveryStore: memoryRecoveryStore(),
    });
    await Promise.resolve();
    expect(api.importLegacyNote).toHaveBeenCalledOnce();
    const owner = api.importLegacyNote.mock.calls[0][1] as string;
    release(owner);
    await expect(Promise.all([first, second])).resolves.toEqual([
      `/daily#owner=${owner}`,
      `/daily#owner=${owner}`,
    ]);
  });

  it("allows retry after a failed convert and does not report success", async () => {
    const doc = new Y.Doc();
    doc.getText("content").insert(0, "retry me");
    const api = {
      importLegacyNote: vi.fn()
        .mockRejectedValueOnce(new Error("network lost"))
        .mockImplementation(async (_body: unknown, owner: string) => ({
          capabilities: { owner },
        })),
      createNote: vi.fn(),
    };
    const input = {
      slug: "daily",
      doc,
      source: {
        slug: "daily",
        content: "retry me",
        ydocState: "",
        isEncrypted: false,
        salt: null as string | null,
        check: null as string | null,
        iterations: null as number | null,
      },
      api,
      recoveryStore: memoryRecoveryStore(),
    };

    await expect(convertPlainNoteOnWrite(input)).rejects.toThrow("network lost");
    const path = await convertPlainNoteOnWrite(input);
    expect(api.importLegacyNote).toHaveBeenCalledTimes(2);
    expect(path.startsWith("/daily#owner=")).toBe(true);
  });
});
