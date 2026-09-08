import { useRef, useState } from "react";
import { Lock, LockOpen } from "lucide-react";
import { useLocation, useNavigate } from "react-router";
import * as Y from "yjs";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useIsMobile } from "@/hooks/use-mobile";
import { useI18n } from "@/i18n";
import type { CapabilityAccess } from "@/lib/capability/url";
import {
  buildLegacyOptInLocation,
  DUPLICATE_SECURELY_AVAILABLE,
  hasConfirmedLegacyOptIn,
  markLegacyOptInConfirmed,
} from "@/lib/legacy/legacy-opt-in";
import type { SnapshotProtection } from "@/lib/snapshots";
import type { YjsProviderLike } from "@/lib/yjs/provider";
import { cn } from "@/lib/utils";
import { LockButton } from "./LockButton";
import { SecuritySwitch } from "./SecuritySwitch";

const canaryOn = import.meta.env.VITE_CAPABILITY_ROUTES_ENABLED === "true";

export interface NoteSecurityPanelProps {
  slug: string;
  doc?: Y.Doc | null;
  isEncrypted?: boolean;
  provider?: YjsProviderLike | null;
  capabilityAccess?: CapabilityAccess | null;
  encryption?: SnapshotProtection | null;
  allowEncryptionTransitions?: boolean;
  legacyOn?: boolean;
  loading?: boolean;
  /** Share-view (and similar): hide owner controls, show owner-only copy. */
  ownerOnly?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function LegacyRoBanner({ onOpenSecurity }: { onOpenSecurity: () => void }) {
  const { t } = useI18n();
  return (
    <div
      role="status"
      className="flex min-h-11 flex-wrap items-center gap-2 border-b bg-muted/40 px-3 py-2 text-sm"
    >
      <p className="text-muted-foreground">{t("security.legacy_banner")}</p>
      <Button
        type="button"
        variant="link"
        className="min-h-11 px-2"
        onClick={onOpenSecurity}
      >
        {t("security.legacy_banner_open")}
      </Button>
    </div>
  );
}

export function NoteSecurityPanel({
  slug,
  doc = null,
  isEncrypted = false,
  provider = null,
  capabilityAccess = null,
  encryption = null,
  allowEncryptionTransitions = false,
  legacyOn = false,
  loading = false,
  ownerOnly = false,
  open: openProp,
  onOpenChange,
}: NoteSecurityPanelProps) {
  const { t } = useI18n();
  const isMobile = useIsMobile();
  const navigate = useNavigate();
  const location = useLocation();
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const [confirmKind, setConfirmKind] = useState<"full" | "short" | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const open = openProp ?? uncontrolledOpen;
  const setOpen = onOpenChange ?? setUncontrolledOpen;
  const showLegacy = canaryOn && !ownerOnly;
  const showEncrypt = !!doc && !ownerOnly && (canaryOn || allowEncryptionTransitions);
  const busy = loading;
  const isSplit = location.pathname.includes("+");
  const legacyBlocked = Boolean(capabilityAccess) || isSplit;

  const applyLegacy = (enabled: boolean) => {
    navigate(
      buildLegacyOptInLocation(location.pathname, location.search, location.hash, enabled),
      { replace: true },
    );
  };

  const requestLegacy = (next: boolean) => {
    if (busy || ownerOnly || !showLegacy) return;
    if (!next) {
      applyLegacy(false);
      return;
    }
    if (legacyOn || legacyBlocked) return;
    setOpen(false);
    setConfirmKind(hasConfirmedLegacyOptIn(slug) ? "short" : "full");
  };

  const confirmLegacy = () => {
    markLegacyOptInConfirmed(slug);
    setConfirmKind(null);
    applyLegacy(true);
  };

  const triggerButton = (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="h-11 w-11 min-h-11 min-w-11"
      aria-label={t("security.panel_title")}
      aria-expanded={open}
      aria-haspopup="dialog"
    >
      {isEncrypted ? <Lock className="h-4 w-4 text-success" /> : <LockOpen className="h-4 w-4" />}
    </Button>
  );

  const body = (
    <div className="space-y-3">
      <h2 id="note-security-heading" className="text-sm font-semibold">
        {t("security.panel_title")}
      </h2>
      {ownerOnly && (
        <p className="text-xs text-muted-foreground">{t("security.owner_only")}</p>
      )}
      {busy && <p className="text-xs text-muted-foreground">{t("common.loading")}</p>}
      {showEncrypt && doc && (
        <div className="flex min-h-11 items-start justify-between gap-3">
          <div className="min-w-0">
            <p id="security-encrypt-label" className="text-sm font-medium">
              {t("security.encrypt_label")}
            </p>
            <p className="text-[11px] text-muted-foreground">
              {t(allowEncryptionTransitions ? "security.encrypt_helper" : "security.encrypt_helper_unavailable")}
            </p>
          </div>
          <LockButton
            slug={slug}
            doc={doc}
            isEncrypted={isEncrypted}
            provider={provider}
            capabilityAccess={capabilityAccess}
            encryption={encryption}
            layout="switch"
            switchLabelledBy="security-encrypt-label"
            disabled={busy || !allowEncryptionTransitions}
          />
        </div>
      )}
      {showLegacy && (
        <div className="space-y-2 border-t border-border/60 pt-3">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {t("security.advanced")}
          </p>
          <div
            data-testid="security-legacy-row"
            className="flex min-h-11 items-start justify-between gap-3"
          >
            <div className="min-w-0">
              <p id="security-legacy-label" className="text-sm font-medium text-muted-foreground">
                {t("security.legacy_label")}
              </p>
              <p className="text-[11px] text-muted-foreground">
                {capabilityAccess
                  ? t("security.legacy_helper_capability")
                  : isSplit && !legacyOn
                    ? t("security.legacy_helper_split")
                    : legacyOn
                      ? t("security.legacy_helper_on")
                      : t("security.legacy_helper_off")}
              </p>
            </div>
            <SecuritySwitch
              checked={legacyOn}
              disabled={busy || (legacyBlocked && !legacyOn)}
              labelledBy="security-legacy-label"
              onCheckedChange={requestLegacy}
            />
          </div>
          {DUPLICATE_SECURELY_AVAILABLE && (
            <div className="flex min-h-11 items-start justify-between gap-3 opacity-60">
              <div className="min-w-0">
                <p id="security-duplicate-label" className="text-sm font-medium">
                  {t("security.duplicate_label")}
                </p>
                <p className="text-[11px] text-muted-foreground">{t("security.duplicate_helper")}</p>
              </div>
              <SecuritySwitch
                checked={false}
                disabled
                labelledBy="security-duplicate-label"
                onCheckedChange={() => {}}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );

  const confirm = (
    <Dialog
      open={confirmKind !== null}
      onOpenChange={(next) => {
        if (!next) setConfirmKind(null);
      }}
    >
      <DialogContent
        hideClose
        aria-modal="true"
        data-testid="legacy-opt-in-confirm"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          cancelRef.current?.focus();
        }}
        onEscapeKeyDown={() => setConfirmKind(null)}
        onPointerDownOutside={() => setConfirmKind(null)}
        onKeyDown={(event) => {
          if (event.key === "Escape") setConfirmKind(null);
        }}
      >
        <DialogHeader>
          <DialogTitle>{t("security.legacy_confirm_title")}</DialogTitle>
          <DialogDescription>
            {confirmKind === "short"
              ? t("security.legacy_confirm_body_short")
              : t("security.legacy_confirm_body")}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            ref={cancelRef}
            type="button"
            variant="ghost"
            className="min-h-11"
            onClick={() => setConfirmKind(null)}
          >
            {t("lock.cancel")}
          </Button>
          <Button type="button" className="min-h-11" onClick={confirmLegacy}>
            {t("security.legacy_confirm_turn_on")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  if (isMobile) {
    return (
      <>
        <Dialog open={open} onOpenChange={setOpen}>
          <Tooltip>
            <TooltipTrigger asChild>
              <DialogTrigger asChild>{triggerButton}</DialogTrigger>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t("security.panel_title")}</TooltipContent>
          </Tooltip>
          <DialogContent
            hideClose={false}
            aria-labelledby="note-security-heading"
            className={cn(
              "top-auto bottom-0 left-0 right-0 max-w-none translate-x-0 translate-y-0 rounded-t-xl sm:rounded-t-xl",
            )}
          >
            {body}
          </DialogContent>
        </Dialog>
        {confirm}
      </>
    );
  }

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>{triggerButton}</PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">{t("security.panel_title")}</TooltipContent>
        </Tooltip>
        <PopoverContent
          align="end"
          role="dialog"
          aria-labelledby="note-security-heading"
          className="w-80 p-4 sm:w-96"
        >
          {body}
        </PopoverContent>
      </Popover>
      {confirm}
    </>
  );
}
