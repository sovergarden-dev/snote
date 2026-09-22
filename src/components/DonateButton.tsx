import { Heart } from "lucide-react";
import { useEffect, useLayoutEffect, useState, type MouseEvent } from "react";
import { useLocation } from "react-router";
import { useI18n } from "@/i18n";
import { shouldHideDonateFab } from "@/lib/donate-fab-visibility";
import {
  dismissIdleFab,
  isIdleDismissed,
  readIdleDismissUntil,
} from "@/lib/kofi-fab-idle-dismiss";
import { PWA_UPDATE_STATE_EVENT } from "@/lib/pwa-update-readiness";
import { cn } from "@/lib/utils";

const KOFI_HREF = "https://ko-fi.com/sovergarden";
const SNOOZE_KEY = "pwa-fab-snooze";

function readSnooze(): string | null {
  try {
    return sessionStorage.getItem(SNOOZE_KEY);
  } catch {
    return null;
  }
}

function writeSnooze(buildId: string): void {
  try {
    sessionStorage.setItem(SNOOZE_KEY, buildId);
  } catch {
    /* ignore */
  }
}

function readPwaFabState(): { updateAvailable: boolean; occurrenceId: string } {
  if (typeof window === "undefined") {
    return { updateAvailable: false, occurrenceId: "available" };
  }
  const state = window.__SNOTE_PWA_UPDATE_STATE__;
  return {
    updateAvailable: !!state?.updateAvailable,
    occurrenceId: state?.pendingBuildId ?? state?.currentBuildId ?? "available",
  };
}

const FAB_DISK =
  "flex items-center justify-center rounded-full bg-background/80 text-primary shadow-sm backdrop-blur-md";

/**
 * Fixed floating support-the-project button. Idle: single-click opens Ko-fi
 * in a new tab and dismisses the idle FAB for 24h (localStorage until-key).
 * When a PWA update is available, the #153 cluster wins over idle dismiss.
 * Shares the bottom-end corner with `PageIndicator` (indicator shifts left
 * via `--snote-fab-primary-disk` only while a FAB is mounted). Hidden in
 * Zen mode via the shared `zen-hide` class.
 */
export function DonateButton() {
  const { pathname } = useLocation();
  const { t } = useI18n();
  const [pwa, setPwa] = useState(readPwaFabState);
  const [snoozedBuildId, setSnoozedBuildId] = useState<string | null>(readSnooze);
  const [dismissUntil, setDismissUntil] = useState<number | null>(readIdleDismissUntil);

  const hideFab = shouldHideDonateFab(pathname);
  const showUpdate = !hideFab && pwa.updateAvailable && pwa.occurrenceId !== snoozedBuildId;
  const showIdle = !hideFab && !showUpdate && !isIdleDismissed(dismissUntil);

  useEffect(() => {
    const sync = () => setPwa(readPwaFabState());
    sync();
    window.addEventListener(PWA_UPDATE_STATE_EVENT, sync);
    return () => window.removeEventListener(PWA_UPDATE_STATE_EVENT, sync);
  }, []);

  useEffect(() => {
    if (dismissUntil == null) return;
    const remaining = dismissUntil - Date.now();
    if (remaining <= 0) {
      setDismissUntil(null);
      return;
    }
    const id = window.setTimeout(() => setDismissUntil(null), remaining);
    return () => window.clearTimeout(id);
  }, [dismissUntil]);

  useLayoutEffect(() => {
    window.__SNOTE_PWA_SYNC_UPDATE_UI__?.();
  }, [pathname]);

  useLayoutEffect(() => {
    const root = document.documentElement;
    if (showUpdate) {
      root.setAttribute("data-snote-fab-update", "");
      root.removeAttribute("data-snote-fab-idle");
    } else if (showIdle) {
      root.setAttribute("data-snote-fab-idle", "");
      root.removeAttribute("data-snote-fab-update");
    } else {
      root.removeAttribute("data-snote-fab-update");
      root.removeAttribute("data-snote-fab-idle");
    }
    return () => {
      root.removeAttribute("data-snote-fab-update");
      root.removeAttribute("data-snote-fab-idle");
    };
  }, [showUpdate, showIdle]);

  const handleIdleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    const { until } = dismissIdleFab();
    setDismissUntil(until);
    try {
      window.open(KOFI_HREF, "_blank", "noopener,noreferrer");
    } catch {
      /* popup blocked — dismiss still applied */
    }
  };

  if (hideFab) return null;

  const donateAria = t("fab.donate.aria");

  if (!showUpdate) {
    if (!showIdle) return null;
    return (
      <a
        href={KOFI_HREF}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={donateAria}
        data-donate-fab=""
        onClick={handleIdleClick}
        className={cn(
          "zen-hide snote-fab-anchor h-11 w-11",
          FAB_DISK,
          "border border-border transition duration-300 animate-heartbeat motion-reduce:animate-none hover:scale-110 hover:animate-none hover:shadow-lg hover:shadow-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        )}
      >
        <Heart className="h-5 w-5 fill-current" />
      </a>
    );
  }

  return (
    <div
      data-donate-fab=""
      className="zen-hide pointer-events-none snote-fab-anchor h-14 w-14"
    >
      <div role="status" aria-live="polite" className="sr-only">
        {t("fab.update.aria")}
      </div>
      <button
        type="button"
        aria-label={t("fab.update.aria")}
        onClick={() => window.__SNOTE_PWA_APPLY_UPDATE__?.()}
        className={cn(
          "pointer-events-auto absolute inset-0 h-14 w-14",
          FAB_DISK,
          "animate-heartbeat-update motion-reduce:animate-none hover:shadow-lg hover:shadow-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        )}
      >
        <Heart className="h-7 w-7 fill-current" />
      </button>
      <div
        aria-hidden="true"
        className="pointer-events-none absolute bottom-full right-0 mb-2 max-w-[10rem] rounded-full border border-border bg-background/90 px-3 py-1 text-xs font-medium text-foreground shadow-sm backdrop-blur-md"
      >
        {t("fab.update.status")}
      </div>
      <button
        type="button"
        aria-label={t("fab.update.snooze_aria")}
        onClick={() => {
          writeSnooze(pwa.occurrenceId);
          setSnoozedBuildId(pwa.occurrenceId);
        }}
        className="fab-snooze-hit pointer-events-auto absolute right-full top-1/2 mr-2 flex h-11 w-11 -translate-y-1/2 items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="fab-snooze-strike flex h-7 w-7 items-center justify-center rounded-full border border-border bg-background/80 text-primary shadow-sm backdrop-blur-md">
          <Heart className="h-3.5 w-3.5 fill-current" />
        </span>
      </button>
    </div>
  );
}
