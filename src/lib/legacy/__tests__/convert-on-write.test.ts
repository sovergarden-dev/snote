import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { CapabilityApiError } from "@/lib/capability/client";
import {
  consumeConvertSeed,
  convertPlainNoteOnWrite,
  ConvertedSlugUnrecoverableError,
  hasStoredConvertRecovery,
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

  it("treats an LNO miss without recovery as unrecoverable, never create", async () => {
    const doc = new Y.Doc();
    const api = {
      convertLegacyNote: vi.fn(),
      createNote: vi.fn(),
    };

    await expect(convertPlainNoteOnWrite({
      slug: "fresh",
      doc,
      source: null,
      api,
      pendingOwnerStore: memoryOwnerStore(),
    })).rejects.toBeInstanceOf(ConvertedSlugUnrecoverableError);

    expect(api.convertLegacyNote).not.toHaveBeenCalled();
    expect(api.createNote).not.toHaveBeenCalled();
  });

  it("treats a session pending owner as reopen recovery", () => {
    const owner = "c".repeat(43);
    expect(hasStoredConvertRecovery("daily", {
      pendingOwnerStore: memoryOwnerStore(owner),
    })).toBe(true);
    expect(hasStoredConvertRecovery("daily", {
      pendingOwnerStore: memoryOwnerStore(),
    })).toBe(false);
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

  it("reopens with a session owner by restoring #owner=, never create", async () => {
    const doc = new Y.Doc();
    const owner = "c".repeat(43);
    const api = {
      convertLegacyNote: vi.fn(),
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
    expect(api.convertLegacyNote).not.toHaveBeenCalled();
    expect(path).toBe(`/daily#owner=${owner}`);
  });

  it("soft-replaces #owner= when stored convert-legacy cannot match the live checkpoint", async () => {
    const doc = new Y.Doc();
    const recovery = storedRecovery();
    const recoveryStore = memoryRecoveryStore();
    recoveryStore.save("daily", recovery);
    const api = {
      convertLegacyNote: vi.fn(async () => {
        throw slugUnavailable();
      }),
      createNote: vi.fn(),
    };

    const path = await convertPlainNoteOnWrite({
      slug: "daily",
      doc,
      source: null,
      api,
      recoveryStore,
    });

    expect(api.convertLegacyNote).toHaveBeenCalledOnce();
    expect(api.createNote).not.toHaveBeenCalled();
    expect(path).toBe(`/daily#owner=${recovery.owner}`);
  });

  it("does not create after slug_unavailable when recover is impossible", async () => {
    const doc = new Y.Doc();
    const api = {
      convertLegacyNote: vi.fn(),
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
    expect(api.createNote).not.toHaveBeenCalled();
    expect(api.convertLegacyNote).not.toHaveBeenCalled();
  });

  it("does not overwrite a convert seed with an empty reopen doc", async () => {
    const doc = new Y.Doc();
    doc.getText("content").insert(0, "keep me");
    const recoveryStore = memoryRecoveryStore();
    const api = {
      convertLegacyNote: vi.fn(async (_body: unknown, owner: string) => ({
        capabilities: { owner },
      })),
      createNote: vi.fn(),
    };

    await convertPlainNoteOnWrite({
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
      recoveryStore,
    });

    const empty = new Y.Doc();
    await convertPlainNoteOnWrite({
      slug: "daily",
      doc: empty,
      source: null,
      api,
      recoveryStore,
    });

    const seed = consumeConvertSeed("daily");
    expect(seed).toBeInstanceOf(Uint8Array);
    const roundtrip = new Y.Doc();
    Y.applyUpdate(roundtrip, seed!);
    expect(roundtrip.getText("content").toString()).toBe("keep me");
  });
});
