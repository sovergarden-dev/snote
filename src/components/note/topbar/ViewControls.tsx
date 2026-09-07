// Two quick toggles kept as icons: preview pane and scroll sync (only when preview is on).
// Zen mode moved to Mode menu.
//
// Responsive behavior: on viewports < 900 px the editor + preview can't
// realistically share the screen, so the preview button instead toggles the
// visible pane between editor and rendered markdown (handled in NotePage).
// We update the tooltip + aria-label here to match, and hide the scroll-sync
// button entirely on narrow viewports since there's only one pane to scroll.
import { Eye, EyeOff, Link2, Link2Off } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useNarrowViewport } from "@/hooks/use-narrow-viewport";
import { useI18n } from "@/i18n/index";
import { formatModShortcut } from "@/lib/shortcut-hint";

interface ViewControlsProps {
  showPreview: boolean;
  onTogglePreview: () => void;
  scrollSync: boolean;
  onToggleScrollSync: () => void;
  narrowOverride?: boolean;
}

export function ViewControls({
  showPreview,
  onTogglePreview,
  scrollSync,
  onToggleScrollSync,
  narrowOverride,
}: ViewControlsProps) {
  const { t } = useI18n();
  const viewportNarrow = useNarrowViewport();
  const narrow = narrowOverride ?? viewportNarrow;

  // Icon: unified Eye/EyeOff across desktop and mobile for consistency.
  // Tooltip wording still adapts to context (narrow = swap panes, wide =
  // hide/show panel) so the behavior remains clear.
  const PreviewIcon = showPreview ? EyeOff : Eye;

  const ariaLabel = narrow
    ? showPreview
      ? t("view.aria_back_to_editor")
      : t("view.aria_show_preview_full")
    : showPreview
      ? t("view.aria_hide_preview")
      : t("view.aria_show_preview");

  const tooltipLabel = narrow
    ? showPreview
      ? t("view.tooltip_back_to_editor")
      : t("view.tooltip_show_preview_full")
    : showPreview
      ? t("view.tooltip_hide_preview")
      : t("view.tooltip_show_preview");

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            // Slightly bigger touch target on narrow viewports — this button
            // is the primary way mobile users swap between editor and
            // preview, so 36 px (h-9) gives a comfortable tap area without
            // outgrowing the 44 px topbar.
            className={narrow ? "h-9 w-9" : "h-7 w-7"}
            onClick={onTogglePreview}
            aria-label={ariaLabel}
            aria-pressed={narrow ? showPreview : undefined}
          >
            <PreviewIcon className={narrow ? "h-5 w-5" : "h-4 w-4"} />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {tooltipLabel} ({formatModShortcut(["Shift", "V"])})
        </TooltipContent>
      </Tooltip>

      {showPreview && !narrow && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={onToggleScrollSync}
              aria-label={scrollSync ? t("view.aria_scroll_off") : t("view.aria_scroll_on")}
              aria-pressed={scrollSync}
            >
              {scrollSync ? (
                <Link2 className="h-4 w-4" />
              ) : (
                <Link2Off className="h-4 w-4 opacity-60" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {scrollSync ? t("view.tooltip_scroll_off") : t("view.tooltip_scroll_on")}
          </TooltipContent>
        </Tooltip>
      )}
    </>
  );
}
