// Brand block on the left of the Topbar: home link, slug (click → copy URL),
// copy-content button, sync indicator, tag chips.
//
// UX split:
//   - Click the `/slug` text → copies the canonical URL (origin + /slug). The
//     origin is read at click time so custom domains (note.syrin.online) and
//     preview deploys (*.lovable.app) always produce the right link without
//     any hard-coded host.
//   - Click the Copy icon → copies the FULL note body. This used to be a
//     duplicate "Copy URL" action; users have keyboard shortcut + the slug
//     button for that now, so the icon graduates to the more useful action.
import { Link } from "react-router";
import type { RefObject } from "react";
import * as Y from "yjs";
import { ArrowLeft, Cloud, Copy, List } from "lucide-react";
import { SyncIndicator } from "../SyncIndicator";
import { TagChips } from "../TagChips";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { YjsProviderLike } from "@/lib/yjs/provider";
import { toast } from "@/hooks/use-toast";
import { useI18n } from "@/i18n";
import { formatModShortcut } from "@/lib/shortcut-hint";

interface TopbarBrandProps {
  slug: string;
  doc: Y.Doc;
  isEncrypted: boolean;
  /** Phase 2.2 — when present, the SyncIndicator pill renders here. */
  provider?: YjsProviderLike | null;
  /** Returns the current decrypted note body. Used by the Copy icon button. */
  getContent: () => string;
  /** When true, hide the Home arrow. Used by SplitView-embedded panels where
   *  a single top-level Home button already exists. */
  hideHome?: boolean;
  /** Click handler for the cloud icon → opens the local history dialog. */
  onOpenHistory?: () => void;
  outlineOpen?: boolean;
  onToggleOutline?: () => void;
  outlineTriggerRef?: RefObject<HTMLButtonElement>;
}

export function TopbarBrand({
  slug,
  doc,
  isEncrypted,
  provider,
  getContent,
  hideHome = false,
  onOpenHistory,
  outlineOpen,
  onToggleOutline,
  outlineTriggerRef,
}: TopbarBrandProps) {

  const { t } = useI18n();

  const copyUrl = async () => {
    // Always canonicalize to https://note.syrin.online/<slug>, regardless of the
    // current host (note.syrin.online, *.lovable.app, localhost, etc.).
    // Preserve current query string and hash so shared links keep context.
    const { search, hash } = window.location;
    const url = `https://note.syrin.online/${slug}${search}${hash}`;
    await navigator.clipboard.writeText(url);
  };

  const copyContent = async () => {
    const text = getContent();
    if (!text) {
      toast({ title: t("toast.note_empty") });
      return;
    }
    await navigator.clipboard.writeText(text);
    toast({
      title: t("toast.copied_note"),
      description: t("toast.copied_chars", { n: text.length }),
    });
  };

  return (
    <>
      {!hideHome && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Link
              to="/"
              className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
              aria-label={t("brand.home")}
              onContextMenu={(e) => {
                e.preventDefault();
                window.open("/", "_blank", "noopener,noreferrer");
              }}
            >
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </TooltipTrigger>
          <TooltipContent side="bottom">{t("brand.home")}</TooltipContent>
        </Tooltip>
      )}

      <div className="flex min-w-0 items-center gap-2">

        {onOpenHistory ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={onOpenHistory}
                className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                aria-label={t("history.tooltip")}
              >
                <Cloud className="h-3.5 w-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t("history.tooltip")}</TooltipContent>
          </Tooltip>
        ) : (
          <Cloud className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={copyUrl}
              className="truncate rounded-md px-1 font-mono text-sm font-medium hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              aria-label={t("brand.copy_url")}
            >
              /{slug}
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{t("brand.copy_url")}</TooltipContent>
        </Tooltip>
      </div>

      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={copyContent}
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label={t("brand.copy_content")}
          >
            <Copy className="h-3.5 w-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{t("brand.copy_content")}</TooltipContent>
      </Tooltip>

      {onToggleOutline && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              ref={outlineTriggerRef}
              type="button"
              onClick={onToggleOutline}
              className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
              aria-label={t("brand.outline")}
              aria-controls="note-outline"
              aria-expanded={outlineOpen ?? false}
            >
              <List className="h-3.5 w-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{t("brand.outline")} ({formatModShortcut(["\\"])})</TooltipContent>
        </Tooltip>
      )}

      {provider && (
        <div className="ml-2 flex items-center gap-1">
          <SyncIndicator provider={provider} />
        </div>
      )}

      <TagChips doc={doc} isEncrypted={isEncrypted} />
    </>
  );
}
