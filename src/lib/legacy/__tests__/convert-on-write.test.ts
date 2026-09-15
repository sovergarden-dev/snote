import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { CapabilityApiError } from "@/lib/capability/client";
import {
  consumeConvertSeed,
  convertPlainNoteOnWrite,
  ConvertedSlugUnrecoverableError,
  resetConvertOnWriteForTests,
} from "../convert-on-write";
import type { LegacyImportRecovery } from "../cutover";

function memoryRecoveryStore() {
  let value: unknown = null;
  return {
    load: vi.fn(() => value),
    save: vi.fn((_slug: string, next: unknown) => { value = next; }),
    clear: vi.fn(() => { value = null; }),
  };
}

function memoryOwnerStore(initial: string | null = null) {
  let value: string | null = initial;
  return {
    load: vi.fn(() => value),
    save: vi.fn((_slug: string, owner: string) => { value = owner; }),
    clear: vi.fn(() => { value = null; }),
  };
}

function storedRecovery(owner = "c".repeat(43)): LegacyImportRecovery {
  return {
    sourceSlug: "daily",
    sourceFingerprint: "a".repeat(64),
    owner,
    checkpointId: "b".repeat(64),
    payload: "AQID",
    isEncrypted: false,
    salt: null,
    check: null,
    iterations: null,
  };
}

function slugUnavailable() {
  return new CapabilityApiError("slug unavailable", 409, null, "slug_unavailable");
}

function notFound() {
  return new CapabilityApiError("not found", 404, null, "not_found");
}

afterEach(() => {
  resetConvertOnWriteForTests();
  sessionStorage.clear();
});

describe("W1 convert-on-write", () => {
  it("converts an existing legacy note onto the same slug, not a duplicate locator", async () => {
    const doc = new Y.Doc();
    doc.getText("content").insert(0, "keep me");
    const api = {
      convertLegacyNote: vi.fn(async (_body: unknown, owner: string) => ({
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
    expect(api.convertLegacyNote).toHaveBeenCalledOnce();
    const [body, owner] = api.convertLegacyNote.mock.calls[0] as [
      { slug: string },
      string,
    ];
    expect(body.slug).toBe("daily");
    expect(path).toBe(`/daily#owner=${owner}`);
    expect(consumeConvertSeed("daily")).toBeInstanceOf(Uint8Array);
  });

  it("converts a persisted free-edit slug through convert-legacy when LNO source is missing", async () => {
    const doc = new Y.Doc();
    doc.getText("content").insert(0, "typed after vacant open");
    const api = {
      convertLegacyNote: vi.fn(async (_body: unknown, owner: string) => ({
        capabilities: { owner },
      })),
      createNote: vi.fn(),
    };

    const path = await convertPlainNoteOnWrite({
      slug: "daily",
      doc,
      source: null,
      api,
      pendingOwnerStore: memoryOwnerStore(),
    });

    expect(api.createNote).not.toHaveBeenCalled();
    expect(api.convertLegacyNote).toHaveBeenCalledOnce();
    const [body, owner] = api.convertLegacyNote.mock.calls[0] as [
      { slug: string; checkpointId: string; payload: string; isEncrypted: boolean },
      string,
    ];
    expect(body.slug).toBe("daily");
    expect(body.isEncrypted).toBe(false);
    expect(body.checkpointId).toMatch(/^[a-f0-9]{64}$/);
    expect(body.payload).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(path).toBe(`/daily#owner=${owner}`);
    expect(consumeConvertSeed("daily")).toBeInstanceOf(Uint8Array);
  });

  it("does not mint via create when convert-legacy reports slug_unavailable", async () => {
    const doc = new Y.Doc();
    doc.getText("content").insert(0, "already persisted");
    const api = {
      convertLegacyNote: vi.fn(async () => {
        throw slugUnavailable();
      }),
      createNote: vi.fn(),
    };

    await expect(convertPlainNoteOnWrite({
      slug: "daily",
      doc,
      source: null,
      api,
      pendingOwnerStore: memoryOwnerStore(),
    })).rejects.toMatchObject({ code: "slug_unavailable", status: 409 });
    expect(api.convertLegacyNote).toHaveBeenCalledOnce();
    expect(api.createNote).not.toHaveBeenCalled();
  });

  it("mints an empty new note through create after convert-legacy not_found", async () => {
    const doc = new Y.Doc();
    const api = {
      convertLegacyNote: vi.fn(async () => {
        throw notFound();
      }),
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

    expect(api.convertLegacyNote).toHaveBeenCalledOnce();
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
      convertLegacyNote: vi.fn((_body: unknown, owner: string) => new Promise<{
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
    await vi.waitFor(() => expect(api.convertLegacyNote).toHaveBeenCalledOnce());
    const owner = api.convertLegacyNote.mock.calls[0][1] as string;
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
      convertLegacyNote: vi.fn()
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
    expect(api.convertLegacyNote).toHaveBeenCalledTimes(2);
    expect(path.startsWith("/daily#owner=")).toBe(true);
  });

  it("reopens a converted slug through stored convert-legacy recovery, never create", async () => {
    const doc = new Y.Doc();
    const owner = "c".repeat(43);
    const recovery = storedRecovery(owner);
    const recoveryStore = memoryRecoveryStore();
    recoveryStore.save("daily", recovery);
    const api = {
      convertLegacyNote: vi.fn(async (_body: unknown, candidate: string) => ({
        capabilities: { owner: candidate },
      })),
      createNote: vi.fn(),
    };

    const path = await convertPlainNoteOnWrite({
      slug: "daily",
      doc,
      source: null,
      api,
      recoveryStore,
    });

    expect(api.createNote).not.toHaveBeenCalled();
    expect(api.convertLegacyNote).toHaveBeenCalledOnce();
    expect(api.convertLegacyNote).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: "daily",
        checkpointId: recovery.checkpointId,
        payload: recovery.payload,
      }),
      owner,
    );
    expect(path).toBe(`/daily#owner=${owner}`);
    expect(consumeConvertSeed("daily")).toBeInstanceOf(Uint8Array);
  });

  it("persists the convert owner so a later reopen can recover", async () => {
    const doc = new Y.Doc();
    doc.getText("content").insert(0, "keep me");
    const pendingOwnerStore = memoryOwnerStore();
    const convertRecoveryStore = memoryRecoveryStore();
    const api = {
      convertLegacyNote: vi.fn(async (_body: unknown, owner: string) => ({
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
      pendingOwnerStore,
      convertRecoveryStore,
    });

    const owner = api.convertLegacyNote.mock.calls[0][1] as string;
    expect(path).toBe(`/daily#owner=${owner}`);
    expect(pendingOwnerStore.save).toHaveBeenCalledWith("daily", owner);
    expect(convertRecoveryStore.save).toHaveBeenCalledWith(
      "daily",
      expect.objectContaining({ owner, sourceSlug: "daily" }),
    );
  });

  it("reopens with a session owner through convert-legacy before create", async () => {
    const doc = new Y.Doc();
    const owner = "c".repeat(43);
    const api = {
      convertLegacyNote: vi.fn(async (_body: unknown, candidate: string) => ({
        capabilities: { owner: candidate },
      })),
      createNote: vi.fn(),
    };

    const path = await convertPlainNoteOnWrite({
      slug: "daily",
      doc,
      source: null,
      api,
      pendingOwnerStore: memoryOwnerStore(owner),
    });

    expect(api.createNote).not.toHaveBeenCalled();
    expect(api.convertLegacyNote).toHaveBeenCalledOnce();
    expect(api.convertLegacyNote.mock.calls[0][1]).toBe(owner);
    expect(path).toBe(`/daily#owner=${owner}`);
  });

  it("falls back to create when session-owner convert-legacy finds no legacy row", async () => {
    const doc = new Y.Doc();
    const owner = "c".repeat(43);
    const api = {
      convertLegacyNote: vi.fn(async () => {
        throw notFound();
      }),
      createNote: vi.fn(async (_slug: string, candidate: string) => ({
        capabilities: { owner: candidate },
      })),
    };

    const path = await convertPlainNoteOnWrite({
      slug: "daily",
      doc,
      source: null,
      api,
      pendingOwnerStore: memoryOwnerStore(owner),
    });

    expect(api.convertLegacyNote).toHaveBeenCalledOnce();
    expect(api.createNote).toHaveBeenCalledOnce();
    expect(api.createNote.mock.calls[0][1]).toBe(owner);
    expect(path).toBe(`/daily#owner=${owner}`);
  });

  it("does not retry create after vacant convert-legacy not_found then create slug_unavailable", async () => {
    const doc = new Y.Doc();
    const api = {
      convertLegacyNote: vi.fn(async () => {
        throw notFound();
      }),
      createNote: vi.fn(async () => {
        throw slugUnavailable();
      }),
    };

    await expect(convertPlainNoteOnWrite({
      slug: "daily",
      doc,
      source: null,
      api,
      pendingOwnerStore: memoryOwnerStore(),
    })).rejects.toBeInstanceOf(ConvertedSlugUnrecoverableError);
    expect(api.convertLegacyNote).toHaveBeenCalledOnce();
    expect(api.createNote).toHaveBeenCalledOnce();
  });
});
