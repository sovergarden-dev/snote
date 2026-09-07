import { Heart } from "lucide-react";
import { useEffect, useState } from "react";
import { useLocation } from "react-router";
import { useI18n } from "@/i18n";
import { shouldHideDonateFab } from "@/lib/donate-fab-visibility";
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
  "flex h-11 w-11 items-center justify-center rounded-full bg-background/80 text-primary shadow-sm backdrop-blur-md";

/**
 * Fixed floating support-the-project button. Idle: single-click opens Ko-fi
 * in a new tab. When a PWA update is available, the primary click reloads;
 * Ko-fi stays on a secondary heart. Anchored above `PageIndicator`. Hidden
 * in Zen mode via the shared `zen-hide` class.
 */
export function DonateButton() {
  const { pathname } = useLocation();
  const { t } = useI18n();
  const [pwa, setPwa] = useState(readPwaFabState);
  const [snoozedBuildId, setSnoozedBuildId] = useState<string | null>(readSnooze);

  useEffect(() => {
    const sync = () => setPwa(readPwaFabState());
    sync();
    window.addEventListener(PWA_UPDATE_STATE_EVENT, sync);
    return () => window.removeEventListener(PWA_UPDATE_STATE_EVENT, sync);
  }, []);

  useEffect(() => {
    window.__SNOTE_PWA_SYNC_UPDATE_UI__?.();
  }, [pathname]);

  if (shouldHideDonateFab(pathname)) return null;

  const showUpdate = pwa.updateAvailable && pwa.occurrenceId !== snoozedBuildId;
  const donateAria = t("fab.donate.aria");

  if (!showUpdate) {
    return (
      <a
        href={KOFI_HREF}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={donateAria}
        className={cn(
          "zen-hide fixed bottom-20 right-4 z-40",
          FAB_DISK,
          "border border-border transition duration-300 animate-heartbeat motion-reduce:animate-none hover:scale-110 hover:animate-none hover:shadow-lg hover:shadow-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        )}
      >
        <Heart className="h-5 w-5 fill-current" />
      </a>
    );
  }

  return (
    <div className="zen-hide pointer-events-none fixed bottom-20 right-4 z-40 h-11 w-11">
      <div role="status" aria-live="polite" className="sr-only">
        {t("fab.update.aria")}
      </div>
      <button
        type="button"
        aria-label={t("fab.update.aria")}
        onClick={() => window.__SNOTE_PWA_APPLY_UPDATE__?.()}
        className={cn(
          "pointer-events-auto absolute inset-0",
          FAB_DISK,
          "animate-heartbeat-update motion-reduce:animate-none hover:shadow-lg hover:shadow-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        )}
      >
        <Heart className="h-5 w-5 fill-current" />
        <span
          aria-hidden="true"
          className="absolute -right-1 -top-1 rounded-full bg-primary px-1 text-[9px] font-bold leading-4 text-primary-foreground"
        >
          {t("fab.update.badge")}
        </span>
      </button>
      <button
        type="button"
        aria-label={t("fab.update.snooze_aria")}
        onClick={() => {
          writeSnooze(pwa.occurrenceId);
          setSnoozedBuildId(pwa.occurrenceId);
        }}
        className="pointer-events-auto absolute bottom-full right-0 mb-2 min-h-11 rounded-full border border-border bg-background/90 px-3 text-xs font-medium text-muted-foreground shadow-sm backdrop-blur-md hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {t("fab.update.snooze")}
      </button>
      <a
        href={KOFI_HREF}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={donateAria}
        className="pointer-events-auto absolute right-full top-1/2 mr-1 flex h-11 w-11 -translate-y-1/2 items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="flex h-7 w-7 items-center justify-center rounded-full border border-border bg-background/80 text-primary shadow-sm backdrop-blur-md">
          <Heart className="h-3.5 w-3.5 fill-current" />
        </span>
      </a>
    </div>
  );
}
