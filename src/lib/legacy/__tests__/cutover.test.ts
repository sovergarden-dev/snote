import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  allocateDuplicateSlug,
  createLegacyNoteApi,
  duplicateLegacyNote,
  mapDuplicateFailure,
} from "../cutover";
import {
  legacyShareCutoffMs,
  parseLegacyShareFragment,
  sanitizeLegacyShareLocation,
} from "../share-url";

const TEST_CUTOFF = Date.parse("2026-08-23T12:00:00.000Z");

function memoryRecoveryStore() {
  let value: unknown = null;
  return {
    load: vi.fn(() => value),
    save: vi.fn((_slug: string, next: unknown) => { value = next; }),
    clear: vi.fn(() => { value = null; }),
  };
}

describe("atomic capability cutover", () => {
  it("opens a legacy note only by exact locator and never sends a capability-like query", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ exists: true, note: null }), {
      status: 200,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    }));
    const api = createLegacyNoteApi({ baseUrl: "https://db.example", fetcher });

    await expect(api.exists("daily")).resolves.toBe(true);
    expect(fetcher).toHaveBeenCalledWith(
      "https://db.example/functions/v1/legacy-note-open",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "exists", slug: "daily" }),
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
      }),
    );
  });

  it("duplicates plaintext into a new owner-scoped capability note", async () => {
    const doc = new Y.Doc();
    doc.getText("content").insert(0, "preserve me");
    const recoveryStore = memoryRecoveryStore();
    const api = {
      importLegacyNote: vi.fn(async (_body: unknown, owner: string) => ({
        capabilities: { owner, edit: "e".repeat(43), view: "v".repeat(43) },
      })),
    };

    const url = await duplicateLegacyNote({
      api,
      source: {
        slug: "daily",
        content: "preserve me",
        ydocState: "",
        isEncrypted: false,
        salt: null,
        check: null,
        iterations: null,
      },
      doc,
      targetSlug: "daily-secure",
      recoveryStore,
    });

    expect(api.importLegacyNote).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: "daily-secure",
        isEncrypted: false,
        checkpointId: expect.stringMatching(/^[a-f0-9]{64}$/),
        payload: expect.any(String),
        salt: null,
        check: null,
        iterations: null,
      }),
      expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    );
    const owner = api.importLegacyNote.mock.calls[0][1];
    expect(recoveryStore.save.mock.invocationCallOrder[0])
      .toBeLessThan(api.importLegacyNote.mock.invocationCallOrder[0]);
    expect(url).toBe(`https://note.syrin.online/daily-secure#owner=${owner}`);
  });

  it.each([
    ["reserved target slug note", "note"],
    ["reserved target slug Privacy", "Privacy"],
    ["reserved target slug S", "S"],
    ["non-string target slug", 42],
  ] as const)(
    "rejects %s before recovery or import",
    async (_label, targetSlug) => {
      const doc = new Y.Doc();
      doc.getText("content").insert(0, "preserve me");
      const recoveryStore = memoryRecoveryStore();
      const api = {
        importLegacyNote: vi.fn(async (_body: unknown, owner: string) => ({
          capabilities: { owner },
        })),
      };

      await expect(duplicateLegacyNote({
        api,
        source: {
          slug: "daily",
          content: "preserve me",
          ydocState: "",
          isEncrypted: false,
          salt: null,
          check: null,
          iterations: null,
        },
        doc,
        targetSlug: targetSlug as unknown as string,
        recoveryStore,
      })).rejects.toThrow("invalid slug");

      expect(recoveryStore.load).not.toHaveBeenCalled();
      expect(recoveryStore.save).not.toHaveBeenCalled();
      expect(api.importLegacyNote).not.toHaveBeenCalled();
    },
  );

  it("duplicates encrypted notes as an encrypted checkpoint without uploading plaintext", async () => {
    const doc = new Y.Doc();
    doc.getText("content").insert(0, "secret");
    const encrypted = new Uint8Array([9, 8, 7]);
    const encrypt = vi.fn(async () => encrypted);
    const recoveryStore = memoryRecoveryStore();
    const api = {
      importLegacyNote: vi.fn(async (_body: unknown, owner: string) => ({
        capabilities: { owner, edit: "e".repeat(43), view: "v".repeat(43) },
      })),
    };

    const url = await duplicateLegacyNote({
      api,
      source: {
        slug: "locked",
        content: "",
        ydocState: "ciphertext",
        isEncrypted: true,
        salt: "s".repeat(16),
        check: "c".repeat(16),
        iterations: 600_000,
      },
      doc,
      targetSlug: "locked-secure",
      encryption: { encrypt, decrypt: vi.fn() },
      encryptionSecret: "correct horse",
      recoveryStore,
    });

    expect(encrypt).toHaveBeenCalledOnce();
    expect(api.importLegacyNote).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: "locked-secure",
        isEncrypted: true,
        salt: "s".repeat(16),
        check: "c".repeat(16),
        iterations: 600_000,
        checkpointId: expect.stringMatching(/^[a-f0-9]{64}$/),
        payload: "CQgH",
      }),
      expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    );
    const owner = api.importLegacyNote.mock.calls[0][1];
    expect(url).toBe(`https://note.syrin.online/locked-secure#owner=${owner}&key=correct+horse`);
  });

  it("validates and encrypts before the atomic import can reserve a slug", async () => {
    const doc = new Y.Doc();
    doc.getText("content").insert(0, "secret");
    const recoveryStore = memoryRecoveryStore();
    const api = { importLegacyNote: vi.fn() };

    await expect(duplicateLegacyNote({
      api,
      source: {
        slug: "locked",
        content: "",
        ydocState: "ciphertext",
        isEncrypted: true,
        salt: "s".repeat(16),
        check: "c".repeat(16),
        iterations: 600_000,
      },
      doc,
      targetSlug: "locked-secure",
      encryption: null,
      encryptionSecret: "",
      recoveryStore,
    })).rejects.toThrow("unlock the legacy note");
    expect(api.importLegacyNote).not.toHaveBeenCalled();
  });

  it("retries a lost import response with the same persisted owner and checkpoint", async () => {
    const doc = new Y.Doc();
    doc.getText("content").insert(0, "secret");
    const recoveryStore = memoryRecoveryStore();
    const encrypt = vi.fn(async () => new Uint8Array([9, 8, 7]));
    const api = {
      importLegacyNote: vi.fn()
        .mockRejectedValueOnce(new Error("network lost after commit"))
        .mockImplementationOnce(async (_body: unknown, owner: string) => ({
          capabilities: { owner },
        })),
    };
    const input = {
      api,
      source: {
        slug: "locked",
        content: "",
        ydocState: "ciphertext",
        isEncrypted: true,
        salt: "s".repeat(16),
        check: "c".repeat(16),
        iterations: 600_000,
      },
      doc,
      targetSlug: "locked-recovery",
      encryption: { encrypt, decrypt: vi.fn() },
      encryptionSecret: "correct horse",
      recoveryStore,
    };

    await expect(duplicateLegacyNote(input)).rejects.toThrow("network lost");
    const recoveredUrl = await duplicateLegacyNote(input);

    expect(encrypt).toHaveBeenCalledOnce();
    expect(api.importLegacyNote).toHaveBeenCalledTimes(2);
    expect(api.importLegacyNote.mock.calls[1]).toEqual(api.importLegacyNote.mock.calls[0]);
    const owner = api.importLegacyNote.mock.calls[0][1];
    expect(recoveredUrl).toContain(`#owner=${owner}`);
  });

  it("refuses to reuse a persisted recovery for a different legacy source", async () => {
    const recoveryStore = memoryRecoveryStore();
    const firstDoc = new Y.Doc();
    firstDoc.getText("content").insert(0, "note A");
    const secondDoc = new Y.Doc();
    secondDoc.getText("content").insert(0, "note B");
    const api = {
      importLegacyNote: vi.fn().mockRejectedValue(new Error("network lost before commit")),
    };
    const common = {
      api,
      targetSlug: "secure-copy",
      recoveryStore,
    };

    await expect(duplicateLegacyNote({
      ...common,
      source: {
        slug: "source-a",
        content: "note A",
        ydocState: "state-a",
        isEncrypted: false,
        salt: null,
        check: null,
        iterations: null,
      },
      doc: firstDoc,
    })).rejects.toThrow("network lost before commit");

    await expect(duplicateLegacyNote({
      ...common,
      source: {
        slug: "source-b",
        content: "note B",
        ydocState: "state-b",
        isEncrypted: false,
        salt: null,
        check: null,
        iterations: null,
      },
      doc: secondDoc,
    })).rejects.toThrow("secure duplicate recovery conflict");

    expect(api.importLegacyNote).toHaveBeenCalledOnce();
  });

  it.each([
    ["reserved source slug", "privacy"],
    ["non-string source slug", 42],
  ] as const)("rejects a persisted recovery with a %s", async (_label, sourceSlug) => {
    const recoveryStore = memoryRecoveryStore();
    recoveryStore.load.mockReturnValue({
      sourceSlug: sourceSlug as unknown as string,
      sourceFingerprint: "a".repeat(64),
      owner: "o".repeat(43),
      checkpointId: "b".repeat(64),
      payload: "AQ",
      isEncrypted: false,
      salt: null,
      check: null,
      iterations: null,
    });
    const api = { importLegacyNote: vi.fn() };
    const doc = new Y.Doc();
    doc.getText("content").insert(0, "preserve me");

    await expect(duplicateLegacyNote({
      api,
      source: {
        slug: "daily",
        content: "preserve me",
        ydocState: "",
        isEncrypted: false,
        salt: null,
        check: null,
        iterations: null,
      },
      doc,
      targetSlug: "secure-copy",
      recoveryStore,
    })).rejects.toThrow("secure duplicate recovery invalid");

    expect(recoveryStore.save).not.toHaveBeenCalled();
    expect(api.importLegacyNote).not.toHaveBeenCalled();
  });

  it("moves a legacy share token from the path into the fragment during the 30-day window", () => {
    const token = "x".repeat(32);
    expect(sanitizeLegacyShareLocation(
      `/s/${token}`,
      "#old%20key",
      TEST_CUTOFF - 1,
      TEST_CUTOFF,
    )).toBe(`/s#legacy=${token}&key=old+key`);
    expect(parseLegacyShareFragment(`#legacy=${token}&key=old+key`, TEST_CUTOFF - 1, TEST_CUTOFF))
      .toEqual({ token, encryptionSecret: "old key" });
  });

  it("drops the raw token after the compatibility deadline", () => {
    const token = "x".repeat(32);
    expect(sanitizeLegacyShareLocation(
      `/s/${token}`,
      "",
      TEST_CUTOFF,
      TEST_CUTOFF,
    )).toBe("/s#legacy-expired=1");
    expect(parseLegacyShareFragment(`#legacy=${token}`, TEST_CUTOFF, TEST_CUTOFF))
      .toBeNull();
  });

  it("fails closed when the deployment cutoff is missing or invalid", () => {
    expect(legacyShareCutoffMs("")).toBe(0);
    expect(legacyShareCutoffMs("not-a-date")).toBe(0);
    expect(legacyShareCutoffMs("2026-08-23T12:00:00.000Z")).toBe(TEST_CUTOFF);
  });
});

describe("Duplicate securely client helpers", () => {
  it("allocates a usable 8-character slug distinct from the source", () => {
    const slug = allocateDuplicateSlug();
    expect(slug).toMatch(/^[a-z0-9]{8}$/);
    expect(slug).not.toBe("daily");
    expect(slug).not.toBe("note");
  });

  it("maps network, permission, and slug conflicts without guessing from error text", () => {
    expect(mapDuplicateFailure(new Error("network lost"))).toBe("network");
    expect(mapDuplicateFailure({ status: 401, code: "unauthorized" })).toBe("permission");
    expect(mapDuplicateFailure({ status: 403, code: "unauthorized" })).toBe("permission");
    expect(mapDuplicateFailure({ status: 409, code: "slug_unavailable" })).toBe("slug_unavailable");
    expect(mapDuplicateFailure({ status: 409, code: "converted_slug_unrecoverable" })).toBe("converted");
    expect(mapDuplicateFailure({ status: 503, code: "unavailable" })).toBe("retry");
    expect(mapDuplicateFailure({ status: 429, code: "rate_limited" })).toBe("retry");
  });
});
