import { useState } from "react";
import * as Y from "yjs";
import { Lock, LockOpen, KeyRound, Loader2, RotateCw, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { toast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import {
  deriveKey,
  decryptBytes,
  encryptBytes,
  generatePassphrase,
  makeCheck,
  randomSalt,
  PBKDF2_ITERATIONS,
} from "@/lib/crypto";
import { bytesToBase64 } from "@/lib/yjs/base64";
import { useI18n } from "@/i18n/index";
import { clearNoteEncryptionPin, markNoteEncrypted } from "@/lib/encryption-pin";
import type { YjsProviderLike } from "@/lib/yjs/provider";
import type { CapabilityAccess } from "@/lib/capability/url";
import { buildCapabilityUrl, readEncryptionSecret } from "@/lib/capability/url";
import type { NoteSession } from "@/lib/capability/client";
import { capabilityPayloadId, encodeCapabilityPayload } from "@/lib/capability/encoding";
import {
  clearSnapshots,
  protectExistingSnapshots,
  unprotectExistingSnapshots,
  type SnapshotProtection,
} from "@/lib/snapshots";
import { SecuritySwitch } from "./SecuritySwitch";

const loadCapabilityApi = import.meta.env.VITE_CAPABILITY_ROUTES_ENABLED === "true"
  ? async () => (await import("@/lib/capability/client")).createCapabilityApi()
  : async () => {
      throw new Error("capability API unavailable");
    };

interface LockButtonProps {
  slug: string;
  doc: Y.Doc;
  isEncrypted: boolean;
  provider?: YjsProviderLike | null;
  capabilityAccess?: CapabilityAccess | null;
  encryption?: SnapshotProtection | null;
  layout?: "icon" | "switch";
  switchLabelledBy?: string;
  disabled?: boolean;
}

type CapabilityProviderSurface = YjsProviderLike & {
  prepareEncryptionTransition: () => Promise<NoteSession>;
  assertEncryptionTransitionStable: () => void;
};

function isCapabilityProvider(provider: YjsProviderLike | null | undefined): provider is CapabilityProviderSurface {
  return !!provider
    && "prepareEncryptionTransition" in provider
    && "assertEncryptionTransitionStable" in provider;
}

function stageCapabilityEncryptionSecret(
  access: CapabilityAccess,
  slug: string,
  secret: string,
) {
  const target = new URL(buildCapabilityUrl(access.scope, access.token, slug, secret));
  window.history.replaceState(
    window.history.state,
    "",
    `${target.pathname}${target.search}${target.hash}`,
  );
}

async function purgePlaintextLocalState(slug: string, protection: SnapshotProtection) {
  try {
    await protectExistingSnapshots(slug, protection);
  } catch {
    // Never leave a partially migrated plaintext recovery history behind.
    await clearSnapshots(slug).catch(() => {});
  }
  try {
    indexedDB.deleteDatabase(`note:${slug}`);
  } catch {
    // Storage can be unavailable in privacy mode. The provider never mounts
    // y-indexeddb for an encrypted note, so failing closed is still safe.
  }
}

async function restorePlaintextSnapshotState(
  slug: string,
  protection: SnapshotProtection | null,
) {
  if (!protection) {
    await clearSnapshots(slug).catch(() => {});
    return;
  }
  try {
    await unprotectExistingSnapshots(slug, protection);
  } catch {
    await clearSnapshots(slug).catch(() => {});
  }
}

export function LockButton({
  slug,
  doc,
  isEncrypted,
  provider = null,
  capabilityAccess = null,
  encryption = null,
  layout = "icon",
  switchLabelledBy = "security-encrypt-label",
  disabled = false,
}: LockButtonProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState(false);

  const currentKey = typeof window !== "undefined"
    ? readEncryptionSecret(window.location.hash)
    : "";

  const copyKey = async () => {
    if (!currentKey) {
      toast({ title: t("lock.no_key_in_url") });
      return;
    }
    const encryptedUrl = capabilityAccess
      ? buildCapabilityUrl(capabilityAccess.scope, capabilityAccess.token, slug, currentKey)
      : `${window.location.origin}/${slug}#${encodeURIComponent(currentKey)}`;
    await navigator.clipboard.writeText(encryptedUrl);
    toast({ title: t("lock.copied_url_key") });
  };

  const lockNote = async (passphrase: string) => {
    setBusy(true);
    try {
      const salt = randomSalt();
      const key = await deriveKey(passphrase, salt, PBKDF2_ITERATIONS);
      const check = await makeCheck(key);
      const state = Y.encodeStateAsUpdate(doc);
      const encrypted = await encryptBytes(key, state);
      const snapshotProtection: SnapshotProtection = {
        encrypt: (bytes) => encryptBytes(key, bytes),
        decrypt: (bytes) => decryptBytes(key, bytes),
      };

      if (capabilityAccess) {
        if (capabilityAccess.scope !== "owner" || !isCapabilityProvider(provider)) {
          throw new Error("owner capability required");
        }
        // Preserve the only decryption secret in the non-network fragment
        // before the server can commit. A lost response can then recover by
        // reloading the authoritative encryption metadata with this key.
        stageCapabilityEncryptionSecret(capabilityAccess, slug, passphrase);
        const session = await provider.prepareEncryptionTransition();
        const freshEncrypted = await encryptBytes(key, Y.encodeStateAsUpdate(doc));
        const checkpointId = await capabilityPayloadId(freshEncrypted);
        provider.assertEncryptionTransitionStable();
        await (await loadCapabilityApi()).manage(capabilityAccess.token, {
          action: "set-encryption",
          isEncrypted: true,
          expectedEncryptionVersion: session.encryption.version,
          salt,
          check,
          iterations: PBKDF2_ITERATIONS,
          checkpoint: {
            checkpointId,
            payload: encodeCapabilityPayload(freshEncrypted),
            throughSequence: session.currentSequence,
          },
        });
        markNoteEncrypted(slug);
        await purgePlaintextLocalState(slug, snapshotProtection);
        toast({ title: t("lock.encrypted_ok") });
        window.location.href = buildCapabilityUrl(
          "owner",
          capabilityAccess.token,
          slug,
          passphrase,
        );
        window.location.reload();
        return;
      }

      const { error } = await supabase
        .from("notes")
        .upsert(
          {
            slug,
            is_encrypted: true,
            enc_salt: salt,
            enc_check: check,
            enc_iterations: PBKDF2_ITERATIONS,
            ydoc_state: bytesToBase64(encrypted),
            content: "",
            char_count: 0,
          },
          { onConflict: "slug" },
        );
      if (error) throw error;

      // The durable local pin closes the legacy-table downgrade window. It is
      // written only after the encrypted upsert succeeds and before reload.
      markNoteEncrypted(slug);
      await purgePlaintextLocalState(slug, snapshotProtection);
      toast({ title: t("lock.encrypted_ok") });
      // Full navigation (not just hash change) so NotePage remounts and the
      // Yjs provider is rebuilt with the new encryption state. Otherwise the
      // stale provider keeps writing in the previous mode and corrupts the row.
      window.location.href = `/${slug}#${encodeURIComponent(passphrase)}`;
      window.location.reload();
    } catch (e) {
      console.error(e);
      toast({
        title: t("lock.encrypt_failed"),
        description: String((e as Error | undefined)?.message ?? e),
        variant: "destructive",
      });
      setBusy(false);
      if (capabilityAccess) window.location.reload();
    }
  };

  const unlockNote = async () => {
    setBusy(true);
    try {
      const text = doc.getText("content").toString();
      const state = Y.encodeStateAsUpdate(doc);
      if (capabilityAccess) {
        if (capabilityAccess.scope !== "owner" || !isCapabilityProvider(provider)) {
          throw new Error("owner capability required");
        }
        const session = await provider.prepareEncryptionTransition();
        const freshState = Y.encodeStateAsUpdate(doc);
        provider.assertEncryptionTransitionStable();
        await (await loadCapabilityApi()).manage(capabilityAccess.token, {
          action: "set-encryption",
          isEncrypted: false,
          expectedEncryptionVersion: session.encryption.version,
          checkpoint: {
            checkpointId: await capabilityPayloadId(freshState),
            payload: encodeCapabilityPayload(freshState),
            throughSequence: session.currentSequence,
          },
        });
        await restorePlaintextSnapshotState(slug, encryption);
        clearNoteEncryptionPin(slug);
        toast({ title: t("lock.decrypted_ok") });
        window.location.href = buildCapabilityUrl("owner", capabilityAccess.token, slug);
        window.location.reload();
        return;
      }
      const { error } = await supabase
        .from("notes")
        .upsert(
          {
            slug,
            is_encrypted: false,
            enc_salt: null,
            enc_check: null,
            ydoc_state: bytesToBase64(state),
            content: text,
            char_count: text.length,
          },
          { onConflict: "slug" },
        );
      if (error) throw error;

      // A failed decrypt must retain the pin. Clear it only after the server
      // acknowledges the explicit transition back to plaintext.
      await restorePlaintextSnapshotState(slug, encryption);
      clearNoteEncryptionPin(slug);
      toast({ title: t("lock.decrypted_ok") });
      // Full reload so the provider re-initializes without the stale
      // encryption key and future saves don't clobber the row.
      window.location.href = `/${slug}`;
      window.location.reload();
    } catch (e) {
      console.error(e);
      toast({
        title: t("lock.decrypt_failed"),
        description: String((e as Error | undefined)?.message ?? e),
        variant: "destructive",
      });
      setBusy(false);
      if (capabilityAccess) window.location.reload();
    }
  };

  const encryptDialog = (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setPass("");
      }}
    >
      {layout === "icon" && (
        <Tooltip>
          <TooltipTrigger asChild>
            <DialogTrigger asChild>
              <Button variant="ghost" size="icon" className="h-7 w-7" aria-label={t("lock.aria_encrypt")}>
                <LockOpen className="h-4 w-4" />
              </Button>
            </DialogTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">{t("lock.tooltip_encrypt")}</TooltipContent>
        </Tooltip>
      )}
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="h-4 w-4" /> {t("lock.dialog_title")}
          </DialogTitle>
          <DialogDescription>{t("lock.dialog_desc")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Input
            value={pass}
            onChange={(e) => setPass(e.target.value)}
            placeholder={t("lock.placeholder")}
            type="text"
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setPass(generatePassphrase(24))}
          >
            <RotateCw className="h-3.5 w-3.5" />
            {t("lock.generate")}
          </Button>
          <p className="text-[11px] text-muted-foreground">{t("lock.warning")}</p>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            {t("lock.cancel")}
          </Button>
          <Button onClick={() => lockNote(pass)} disabled={busy || pass.length < 4}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : t("lock.encrypt_btn")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  if (isEncrypted) {
    if (layout === "switch") {
      return (
        <div className="flex flex-col items-end gap-1">
          <SecuritySwitch
            checked
            disabled={busy || disabled}
            labelledBy={switchLabelledBy}
            onCheckedChange={(next) => {
              if (!next) void unlockNote();
            }}
          />
          <Button type="button" variant="ghost" size="sm" className="h-8 px-2 text-[11px]" onClick={copyKey}>
            <Copy className="h-3.5 w-3.5" />
            {t("lock.copy_url_key")}
          </Button>
        </div>
      );
    }
    return (
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-7 w-7" aria-label={t("lock.aria_encryption")}>
                <Lock className="h-4 w-4 text-success" />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">{t("lock.encrypted_tooltip")}</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={copyKey}>
            <Copy className="h-3.5 w-3.5" />
            {t("lock.copy_url_key")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={unlockNote} disabled={busy}>
            <LockOpen className="h-3.5 w-3.5" />
            {t("lock.unlock")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  if (layout === "switch") {
    return (
      <>
        <SecuritySwitch
          checked={false}
          disabled={busy || disabled}
          labelledBy={switchLabelledBy}
          onCheckedChange={(next) => {
            if (next) setOpen(true);
          }}
        />
        {encryptDialog}
      </>
    );
  }

  return encryptDialog;
}
