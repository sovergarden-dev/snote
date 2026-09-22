import { useRef, useState } from "react";
import { CopyPlus, Loader2, Lock, LockOpen } from "lucide-react";
import { Link, useLocation, useNavigate } from "react-router";
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
  onDuplicateSecurely?: () => void;
  duplicateBusy?: boolean;
  duplicateFeedback?: "network" | "permission" | "retry" | "success" | null;
  /** W2 Secure opt-in: convert via U1. When set, the switch does not use `?legacyRo=1`. */
  onLegacyEnable?: () => void;
  /** W2 Legacy OFF: owner-only reverse RPC. When set, OFF confirms then calls this. */
  onLegacyDisable?: () => void;
  /** Hide Encrypt (Legacy RO viewer). */
  hideEncrypt?: boolean;
}

export function LegacyRoBanner() {
  const { t } = useI18n();
  return (
    <div
      role="status"
      className="flex min-h-11 flex-wrap items-center gap-2 border-b bg-muted px-3 py-2 text-sm text-foreground"
    >
      <p className="flex-1">{t("security.legacy_banner")}</p>
      <Button asChild size="lg" className="min-h-11 min-w-11 px-4">
        <Link to="/">{t("security.legacy_banner_cta")}</Link>
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
  onDuplicateSecurely,
  duplicateBusy = false,
  duplicateFeedback = null,
  onLegacyEnable,
  onLegacyDisable,
  hideEncrypt = false,
}: NoteSecurityPanelProps) {
  const { t } = useI18n();
  const isMobile = useIsMobile();
  const navigate = useNavigate();
  const location = useLocation();
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const [confirmKind, setConfirmKind] = useState<"full" | "short" | "off" | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const open = openProp ?? uncontrolledOpen;
  const setOpen = onOpenChange ?? setUncontrolledOpen;
  const showLegacy = canaryOn && !ownerOnly;
  const showEncrypt = !!doc && !ownerOnly && !hideEncrypt && (canaryOn || allowEncryptionTransitions);
  const busy = loading;
  const isSplit = location.pathname.includes("+");
  const secureMode = Boolean(onLegacyEnable || onLegacyDisable);
  const encryptLockedByLegacy = !isEncrypted && (legacyOn || !allowEncryptionTransitions);
  const legacyLockedByEncrypt = isEncrypted && !legacyOn;
  const encryptHelperKey = encryptLockedByLegacy
    ? (legacyOn ? "security.encrypt_helper_mutex" : "security.encrypt_helper_unavailable")
    : "security.encrypt_helper";
  const legacyHelperKey = isSplit && !legacyOn
    ? "security.legacy_helper_split"
    : isSplit
      ? "security.legacy_helper_on_plain"
      : legacyLockedByEncrypt
        ? "security.legacy_helper_mutex"
        : legacyOn
          ? (secureMode ? "security.legacy_secure_helper_on" : "security.legacy_helper_on")
          : (secureMode ? "security.legacy_secure_helper_off" : "security.legacy_helper_off");

  const applyLegacy = (enabled: boolean) => {
    navigate(
      buildLegacyOptInLocation(location.pathname, location.search, location.hash, enabled),
      { replace: true },
    );
  };

  const requestLegacy = (next: boolean) => {
    if (busy || ownerOnly || !showLegacy) return;
    if (next && legacyLockedByEncrypt) return;
    if (!next) {
      if (isSplit) return;
      if (secureMode) {
        if (!onLegacyDisable) return;
        setOpen(false);
        setConfirmKind("off");
        return;
      }
      applyLegacy(false);
      return;
    }
    if (legacyOn || isSplit) return;
    if (secureMode && !onLegacyEnable) return;
    setOpen(false);
    setConfirmKind(hasConfirmedLegacyOptIn(slug) ? "short" : "full");
  };

  const confirmLegacy = () => {
    markLegacyOptInConfirmed(slug);
    setConfirmKind(null);
    if (onLegacyEnable) {
      onLegacyEnable();
      return;
    }
    applyLegacy(true);
  };

  const confirmLegacyOff = () => {
    setConfirmKind(null);
    onLegacyDisable?.();
  };

  const showDuplicate = DUPLICATE_SECURELY_AVAILABLE && showLegacy && legacyOn
    && Boolean(onDuplicateSecurely || isEncrypted);
  const duplicateFailed = duplicateFeedback === "network"
    || duplicateFeedback === "permission"
    || duplicateFeedback === "retry";
  const duplicateCtaLabel = duplicateBusy
    ? t("security.duplicate_busy")
    : duplicateFailed
      ? t("security.duplicate_retry")
      : t("security.duplicate_label");
  const duplicateHelperKey = duplicateBusy
    ? "security.duplicate_busy" as const
    : duplicateFeedback === "permission"
      ? "security.duplicate_fail_permission" as const
      : duplicateFailed
        ? "security.duplicate_fail" as const
        : duplicateFeedback === "success"
          ? "security.duplicate_success" as const
          : !onDuplicateSecurely && isEncrypted
            ? "security.duplicate_helper_locked" as const
            : "security.duplicate_helper" as const;

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
            <p id="security-encrypt-helper" className="text-[11px] text-muted-foreground">
              {t(encryptHelperKey)}
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
            switchDescribedBy="security-encrypt-helper"
            disabled={busy || encryptLockedByLegacy}
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
                {t(secureMode ? "security.legacy_secure_label" : "security.legacy_label")}
              </p>
              <p id="security-legacy-helper" className="text-[11px] text-muted-foreground">
                {t(legacyHelperKey)}
              </p>
            </div>
            <SecuritySwitch
              checked={legacyOn}
              disabled={busy || isSplit || legacyLockedByEncrypt || (secureMode && legacyOn && !onLegacyDisable)}
              labelledBy="security-legacy-label"
              describedBy="security-legacy-helper"
              onCheckedChange={requestLegacy}
            />
          </div>
          {showDuplicate && (
            <div
              data-testid="security-duplicate-row"
              className="flex min-h-11 items-start justify-between gap-3"
            >
              <div className="min-w-0">
                <p id="security-duplicate-label" className="text-sm font-medium">
                  {t("security.duplicate_label")}
                </p>
                <p
                  className={cn(
                    "text-[11px] text-muted-foreground",
                    duplicateFailed && "text-destructive",
                  )}
                  role={
                    duplicateBusy || duplicateFeedback === "success"
                      ? "status"
                      : duplicateFailed
                        ? "alert"
                        : undefined
                  }
                >
                  {t(duplicateHelperKey)}
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="lg"
                className="h-11 min-h-11 min-w-11 px-3"
                aria-label={duplicateCtaLabel}
                aria-busy={duplicateBusy || undefined}
                disabled={busy || duplicateBusy || duplicateFeedback === "success" || !onDuplicateSecurely}
                onClick={() => onDuplicateSecurely?.()}
              >
                {duplicateBusy
                  ? <Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden="true" />
                  : duplicateFailed
                    ? t("security.duplicate_retry")
                    : <CopyPlus className="h-4 w-4" aria-hidden="true" />}
              </Button>
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
          <DialogTitle>
            {confirmKind === "off"
              ? t("security.legacy_confirm_off_title")
              : t(secureMode ? "security.legacy_secure_confirm_title" : "security.legacy_confirm_title")}
          </DialogTitle>
          <DialogDescription>
            {confirmKind === "off"
              ? t("security.legacy_confirm_off_body")
              : confirmKind === "short"
                ? t(secureMode ? "security.legacy_secure_confirm_body_short" : "security.legacy_confirm_body_short")
                : t(secureMode ? "security.legacy_secure_confirm_body" : "security.legacy_confirm_body")}
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
          <Button
            type="button"
            className="min-h-11"
            onClick={confirmKind === "off" ? confirmLegacyOff : confirmLegacy}
          >
            {t(confirmKind === "off" ? "security.legacy_confirm_turn_off" : "security.legacy_confirm_turn_on")}
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
