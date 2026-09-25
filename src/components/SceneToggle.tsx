import { forwardRef, useCallback, useEffect, useId, useRef, useState } from "react";
import { Check, Sparkles } from "lucide-react";
import { useTheme } from "next-themes";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

import { useSceneTheme } from "@/hooks/use-scene-theme";
import { SCENE_NONE, SCENE_REGISTRY } from "@/components/home/scenes/registry";
import { useI18n } from "@/i18n";

/**
 * SceneToggle — picker for the optional animated background scene.
 *
 * Hover preview: while the dropdown is open, hovering or focusing a scene
 * row temporarily swaps the background to that scene (in-memory preview,
 * not persisted). Closing the menu without clicking reverts.
 *
 * A11y: an aria-live="polite" region announces the previewed scene name as
 * the user moves through the menu (keyboard or pointer), the committed name
 * on selection, and "preview cancelled" when the menu closes without a pick.
 * Reduced-motion users skip the visual preview AND the announcements (no
 * preview = no state change to announce).
 */
export const SceneToggle = forwardRef<HTMLButtonElement>((_props, ref) => {
  const { setTheme } = useTheme();
  const { committedScene, setScene, previewScene } = useSceneTheme();
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const hintId = useId();
  // Clear "Applied X" / "Preview cancelled" messages after a short window so
  // screen readers don't re-announce stale text on focus changes.
  const clearTimerRef = useRef<number | null>(null);
  // Set when select() commits — suppresses the "Preview cancelled" message
  // that handleOpenChange would otherwise emit when the menu auto-closes
  // after a click. Without this, screen readers hear "Applied X" overwritten
  // by "Preview cancelled" before it can be voiced.
  const justCommittedRef = useRef(false);

  const prefersReducedMotion =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const scheduleClear = useCallback(() => {
    if (clearTimerRef.current) window.clearTimeout(clearTimerRef.current);
    clearTimerRef.current = window.setTimeout(() => setAnnouncement(""), 1500);
  }, []);

  useEffect(() => {
    return () => {
      if (clearTimerRef.current) window.clearTimeout(clearTimerRef.current);
    };
  }, []);

  // Selecting a scene pins light/dark. Restore that pin on load too, so a
  // dark scene does not come back on top of a light-theme card.
  useEffect(() => {
    const scheme = SCENE_REGISTRY.find((s) => s.id === committedScene)?.forceColorScheme;
    if (scheme) setTheme(scheme);
  }, [committedScene, setTheme]);

  const select = (id: string) => {
    const def = SCENE_REGISTRY.find((s) => s.id === id);
    const label = def ? t(def.labelKey as Parameters<typeof t>[0]) : id;
    if (id === SCENE_NONE) {
      setScene(SCENE_NONE);
      justCommittedRef.current = true;
      setAnnouncement(t("scene.preview.committed", { name: label }));
      scheduleClear();
      return;
    }
    if (!def || !def.enabled) return;
    if (def.forceColorScheme) setTheme(def.forceColorScheme);
    setScene(def.id);
    justCommittedRef.current = true;
    setAnnouncement(t("scene.preview.committed", { name: label }));
    scheduleClear();
  };

  const startPreview = useCallback(
    (id: string, enabled: boolean, label: string) => {
      if (!enabled || prefersReducedMotion) return;
      if (id === committedScene) {
        // Hovering the already-applied row: just say its name (no preview swap).
        setAnnouncement(label);
        return;
      }
      previewScene(id);
      setAnnouncement(t("scene.preview.announcing", { name: label }));
    },
    [committedScene, previewScene, prefersReducedMotion, t],
  );

  const endPreview = useCallback(() => {
    previewScene(null);
  }, [previewScene]);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next);
      if (!next) {
        previewScene(null);
        if (justCommittedRef.current) {
          // Keep the "Applied X" announcement that select() just set.
          justCommittedRef.current = false;
          return;
        }
        setAnnouncement(t("scene.preview.reverted"));
        scheduleClear();
      } else {
        setAnnouncement("");
      }
    },
    [previewScene, scheduleClear, t],
  );

  const entries = SCENE_REGISTRY.filter((e) => e.id !== SCENE_NONE);

  return (
    <DropdownMenu open={open} onOpenChange={handleOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button
          ref={ref}
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          aria-label={t("scene.toggle.aria")}
        >
          <Sparkles className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-56"
        onMouseLeave={endPreview}
      >
        <DropdownMenuLabel className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          {t("theme.scene.label")}
        </DropdownMenuLabel>
        {/* Visually-hidden hint that every menuitem references for SR users. */}
        <span id={hintId} className="sr-only">
          {t("scene.preview.hint")}
        </span>
        <DropdownMenuRadioGroup value={committedScene} onValueChange={select}>
          {entries.map((e) => {
            const label = t(e.labelKey as Parameters<typeof t>[0]);
            return (
              <DropdownMenuRadioItem
                key={e.id}
                value={e.id}
                disabled={!e.enabled}
                aria-label={label}
                aria-describedby={hintId}
                className="gap-2 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
                onMouseEnter={() => startPreview(e.id, e.enabled, label)}
                onFocus={() => startPreview(e.id, e.enabled, label)}
                onMouseLeave={endPreview}
                onBlur={endPreview}
              >
                <span
                  aria-hidden="true"
                  className="inline-block h-3.5 w-6 shrink-0 rounded-sm ring-1 ring-border"
                  style={{
                    background: `linear-gradient(135deg, ${e.swatch[0]}, ${e.swatch[1]})`,
                  }}
                />
                <span className="flex min-w-0 flex-1 items-center gap-1 truncate text-sm">
                  {label}
                  {!e.enabled && (
                    <span className="ml-1 rounded bg-muted px-1 py-px text-[9px] font-medium uppercase tracking-wider text-muted-foreground">
                      {t("scene.coming_soon")}
                    </span>
                  )}
                </span>
                {committedScene === e.id && e.enabled && (
                  <Check className="ml-auto h-3.5 w-3.5 text-primary" />
                )}
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
      {/* Live region — must be in the DOM at all times (not portalled with the
          menu) so screen readers register it as a live region from page load. */}
      <span
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
        data-testid="scene-toggle-live"
      >
        {announcement}
      </span>
    </DropdownMenu>
  );
});


SceneToggle.displayName = "SceneToggle";
