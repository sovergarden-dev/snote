import { fireEvent, render, waitFor } from "@testing-library/react";
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { LockButton } from "../LockButton";
import { readEncryptionSecret } from "@/lib/capability/url";

const harness = vi.hoisted(() => ({
  upsert: vi.fn(),
  upsertPlainNote: vi.fn(),
  markEncrypted: vi.fn(),
  clearPin: vi.fn(),
  toast: vi.fn(),
  manage: vi.fn(),
  clearSnapshots: vi.fn(),
  protectExistingSnapshots: vi.fn(),
  unprotectExistingSnapshots: vi.fn(),
  errors: [] as unknown[],
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: () => ({ upsert: (...args: unknown[]) => harness.upsert(...args) }),
  },
}));
vi.mock("@/lib/encryption-pin", () => ({
  markNoteEncrypted: (slug: string) => harness.markEncrypted(slug),
  clearNoteEncryptionPin: (slug: string) => harness.clearPin(slug),
}));
vi.mock("@/hooks/use-toast", () => ({ toast: (...args: unknown[]) => harness.toast(...args) }));
vi.mock("@/lib/capability/client", () => ({
  createCapabilityApi: () => ({
    manage: (...args: unknown[]) => harness.manage(...args),
    upsertPlainNote: (...args: unknown[]) => harness.upsertPlainNote(...args),
  }),
}));
vi.mock("@/lib/snapshots", () => ({
  clearSnapshots: (...args: unknown[]) => harness.clearSnapshots(...args),
  protectExistingSnapshots: (...args: unknown[]) => harness.protectExistingSnapshots(...args),
  unprotectExistingSnapshots: (...args: unknown[]) => harness.unprotectExistingSnapshots(...args),
}));
vi.mock("@/i18n/index", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@/lib/crypto", () => ({
  deriveKey: async () => ({}),
  encryptBytes: async () => new Uint8Array([1]),
  generatePassphrase: () => "generated-passphrase",
  makeCheck: async () => "check",
  randomSalt: () => "salt",
  PBKDF2_ITERATIONS: 1000,
}));
vi.mock("@/lib/yjs/base64", () => ({ bytesToBase64: () => "encoded" }));
vi.mock("lucide-react", () => ({
  Lock: () => null,
  LockOpen: () => null,
  KeyRound: () => null,
  Loader2: () => null,
  RotateCw: () => null,
  Copy: () => null,
}));

function Button({
  children,
  variant: _variant,
  size: _size,
  asChild: _asChild,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: string;
  size?: string;
  asChild?: boolean;
}) {
  return <button {...props}>{children}</button>;
}

vi.mock("@/components/ui/button", () => ({ Button }));
vi.mock("@/components/ui/input", () => ({
  Input: (props: InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}));
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children }: { children: ReactNode }) => <>{children}</>,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  DialogTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

describe("LockButton encryption downgrade pin", () => {
  beforeEach(() => {
    harness.upsert.mockReset();
    harness.upsertPlainNote.mockReset();
    harness.markEncrypted.mockReset();
    harness.clearPin.mockReset();
    harness.toast.mockReset();
    harness.manage.mockReset();
    harness.clearSnapshots.mockReset();
    harness.protectExistingSnapshots.mockReset();
    harness.unprotectExistingSnapshots.mockReset();
    harness.errors.length = 0;
    harness.markEncrypted.mockReturnValue(true);
    harness.clearPin.mockReturnValue(true);
    harness.manage.mockResolvedValue({ ok: true });
    harness.upsertPlainNote.mockResolvedValue({ noteId: "n", created: true });
    harness.clearSnapshots.mockResolvedValue(undefined);
    harness.protectExistingSnapshots.mockResolvedValue(undefined);
    harness.unprotectExistingSnapshots.mockResolvedValue(undefined);
    window.history.replaceState(null, "", "/secret");
    vi.spyOn(console, "error").mockImplementation((...args) => {
      if (String(args[0]).includes("Not implemented: navigation")) return;
      harness.errors.push(args);
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it("pins only after the encrypted server upsert succeeds", async () => {
    const pending = deferred<{ noteId: string; created: boolean }>();
    harness.upsertPlainNote.mockReturnValue(pending.promise);
    const view = render(<LockButton slug="secret" doc={new Y.Doc()} isEncrypted={false} />);

    fireEvent.change(view.getByPlaceholderText("lock.placeholder"), {
      target: { value: "safe passphrase" },
    });
    fireEvent.click(view.getByText("lock.encrypt_btn"));
    expect(harness.markEncrypted).not.toHaveBeenCalled();

    pending.resolve({ noteId: "n", created: true });
    await waitFor(() => expect(harness.markEncrypted).toHaveBeenCalledWith("secret"));
    expect(harness.upsert).not.toHaveBeenCalled();
    expect(harness.upsertPlainNote).toHaveBeenCalledWith(expect.objectContaining({
      slug: "secret",
      isEncrypted: true,
      content: "",
      charCount: 0,
      tags: [],
    }));
  });

  it("clears only after the explicit plaintext upsert succeeds", async () => {
    const pending = deferred<{ noteId: string; created: boolean }>();
    harness.upsertPlainNote.mockReturnValue(pending.promise);
    const view = render(<LockButton slug="secret" doc={new Y.Doc()} isEncrypted />);

    fireEvent.click(view.getByText("lock.unlock"));
    expect(harness.clearPin).not.toHaveBeenCalled();

    pending.resolve({ noteId: "n", created: false });
    await waitFor(() => expect(harness.clearPin).toHaveBeenCalledWith("secret"));
    expect(harness.upsert).not.toHaveBeenCalled();
  });

  it("retains the pin when explicit decryption fails", async () => {
    harness.upsertPlainNote.mockRejectedValue(new Error("write failed"));
    const view = render(<LockButton slug="secret" doc={new Y.Doc()} isEncrypted />);

    fireEvent.click(view.getByText("lock.unlock"));

    await waitFor(() => expect(harness.upsertPlainNote).toHaveBeenCalled());
    expect(harness.clearPin).not.toHaveBeenCalled();
    expect(harness.upsert).not.toHaveBeenCalled();
  });

  it("uses owner-only checkpoint CAS instead of the public notes table", async () => {
    const provider = {
      flushNow: vi.fn().mockResolvedValue(undefined),
      refreshNow: vi.fn().mockResolvedValue(undefined),
      prepareEncryptionTransition: vi.fn().mockResolvedValue({
        currentSequence: 7,
        encryption: { version: 2 },
      }),
      assertEncryptionTransitionStable: vi.fn(),
      hasUnflushedLocalChanges: () => false,
      getSession: () => ({
        currentSequence: 7,
        encryption: { version: 2 },
      }),
    };
    const view = render(
      <LockButton
        slug="secret"
        doc={new Y.Doc()}
        isEncrypted={false}
        provider={provider as never}
        capabilityAccess={{ slug: "secret", scope: "owner", token: "o".repeat(43) }}
      />,
    );
    fireEvent.change(view.getByPlaceholderText("lock.placeholder"), {
      target: { value: "safe passphrase" },
    });
    fireEvent.click(view.getByText("lock.encrypt_btn"));

    await waitFor(() => expect(provider.prepareEncryptionTransition).toHaveBeenCalled());
    expect(harness.errors).toEqual([]);
    await waitFor(() => expect(harness.manage).toHaveBeenCalled());
    expect(harness.upsert).not.toHaveBeenCalled();
    expect(harness.manage.mock.calls[0][1]).toMatchObject({
      action: "set-encryption",
      isEncrypted: true,
      expectedEncryptionVersion: 2,
      checkpoint: { throughSequence: 7 },
    });
    expect(provider.prepareEncryptionTransition).toHaveBeenCalledBefore(harness.manage);
    expect(provider.assertEncryptionTransitionStable).toHaveBeenCalledBefore(harness.manage);
    await waitFor(() => expect(harness.protectExistingSnapshots).toHaveBeenCalledWith(
      "secret",
      expect.objectContaining({ encrypt: expect.any(Function), decrypt: expect.any(Function) }),
    ));
  });

  it("stages the passphrase in the fragment before the encryption mutation can commit", async () => {
    const token = "o".repeat(43);
    window.history.replaceState(null, "", `/secret#owner=${token}`);
    const pending = deferred<Record<string, unknown>>();
    harness.manage.mockReturnValue(pending.promise);
    const provider = {
      prepareEncryptionTransition: vi.fn().mockResolvedValue({
        currentSequence: 7,
        encryption: { version: 2 },
      }),
      assertEncryptionTransitionStable: vi.fn(),
      flushNow: vi.fn().mockResolvedValue(undefined),
      refreshNow: vi.fn().mockResolvedValue(undefined),
      hasUnflushedLocalChanges: () => false,
      getSession: () => ({ currentSequence: 7, encryption: { version: 2 } }),
    };
    const view = render(
      <LockButton
        slug="secret"
        doc={new Y.Doc()}
        isEncrypted={false}
        provider={provider as never}
        capabilityAccess={{ slug: "secret", scope: "owner", token }}
      />,
    );
    fireEvent.change(view.getByPlaceholderText("lock.placeholder"), {
      target: { value: "recoverable passphrase" },
    });
    fireEvent.click(view.getByText("lock.encrypt_btn"));

    await waitFor(() => expect(harness.manage).toHaveBeenCalled());
    expect(readEncryptionSecret(window.location.hash)).toBe("recoverable passphrase");
    expect(provider.prepareEncryptionTransition).toHaveBeenCalledOnce();
    expect(provider.assertEncryptionTransitionStable).toHaveBeenCalledBefore(harness.manage);
    pending.resolve({ ok: true });
  });
});
