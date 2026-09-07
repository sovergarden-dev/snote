import { useEffect, useRef, useState, type RefObject } from "react";
import * as Y from "yjs";
import { X } from "lucide-react";

import { parseOutline, type Heading } from "@/lib/outline";
import { buildNoteGraphRecord } from "@/lib/note-graph";
import {
  getBacklinks,
  hydrateNoteIndex,
  listDeadOutgoing,
  noteIsOrphan,
  subscribeNoteIndex,
  type NoteIndexEntry,
} from "@/lib/note-index";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n/index";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";


interface OutlineSidebarProps {
  id?: string;
  slug: string;
  doc: Y.Doc;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with a 0-indexed line number when user clicks a heading. */
  onJump: (line: number) => void;
  onOpenNote?: (slug: string) => void;
  triggerRef: RefObject<HTMLButtonElement>;
}

/**
 * Table of Contents.
 *  - Desktop/tablet: in-flow sidebar that reflows (pushes) the editor.
 *  - Mobile: overlay + backdrop; Esc and close dismiss.
 *  - Does not steal caret/focus from the editor (composing stays usable).
 */
export function OutlineSidebar({
  id = "note-outline",
  slug,
  doc,
  open,
  onOpenChange,
  onJump,
  onOpenNote,
}: OutlineSidebarProps) {
  const { t } = useI18n();
  const isMobile = useIsMobile();
  const [headings, setHeadings] = useState<Heading[]>([]);
  const [content, setContent] = useState("");
  const [, setIndexEpoch] = useState(0);
  const closeRef = useRef<HTMLButtonElement>(null);

  // Re-parse outline whenever the doc changes, but defer to idle callbacks so
  // long notes don't pay parse cost on every keystroke.
  useEffect(() => {
    const ytext = doc.getText("content");
    let timer: number | null = null;
    let ridle: number | null = null;
    const w = window as unknown as {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    const run = () => {
      const text = ytext.toString();
      setContent(text);
      setHeadings(parseOutline(text));
    };
    const schedule = () => {
      if (timer) window.clearTimeout(timer);
      if (ridle) w.cancelIdleCallback?.(ridle);
      timer = window.setTimeout(() => {
        if (w.requestIdleCallback) ridle = w.requestIdleCallback(run, { timeout: 600 });
        else run();
      }, 200);
    };
    run();
    ytext.observe(schedule);
    return () => {
      if (timer) window.clearTimeout(timer);
      if (ridle) w.cancelIdleCallback?.(ridle);
      ytext.unobserve(schedule);
    };
  }, [doc]);

  useEffect(() => {
    void hydrateNoteIndex();
    return subscribeNoteIndex(() => setIndexEpoch((n) => n + 1));
  }, []);

  // Keep the keyboard shortcut local to the one standalone outline instance.
  // Embedded SplitView notes do not render OutlineSidebar, so a shortcut can
  // never toggle several drawers at once.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "\\") {
        e.preventDefault();
        onOpenChange(!open);
      } else if (e.key === "Escape" && open) {
        e.preventDefault();
        onOpenChange(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onOpenChange, open]);

  const handleJump = (line: number) => {
    onJump(line);
    if (isMobile) onOpenChange(false);
  };

  const handleOpenNote = (target: string) => {
    onOpenNote?.(target);
    if (isMobile) onOpenChange(false);
  };

  if (!open) return null;

  const live = buildNoteGraphRecord(slug, content);
  const backlinks = getBacklinks(slug);
  const dead = listDeadOutgoing(slug, live.outgoingLinks);
  const substantial = content.trim().length >= 80 || headings.length > 0;
  const showOrphan = substantial && noteIsOrphan(slug, live.outgoingLinks);

  return (
    <>
      {isMobile && (
        <div
          data-outline-backdrop=""
          className="fixed inset-0 z-30 bg-background/40 backdrop-blur-sm"
          onClick={() => onOpenChange(false)}
          aria-hidden
        />
      )}

      <aside
        id={id}
        role={isMobile ? "dialog" : "complementary"}
        aria-modal={isMobile ? false : undefined}
        className={cn(
          "zen-hide flex w-72 max-w-[85vw] shrink-0 flex-col border-r border-border bg-background",
          isMobile
            ? "fixed bottom-0 left-0 top-11 z-40 shadow-lg"
            : "relative h-full min-h-0",
        )}
        aria-label={t("brand.outline")}
      >
        <div className="flex h-10 items-center justify-between border-b border-border px-3">
          <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            {t("brand.outline")}
          </span>
          <Button
            ref={closeRef}
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => onOpenChange(false)}
            aria-label={t("outline.close")}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="h-[calc(100%-2.5rem)] overflow-y-auto px-2 py-2">
          {headings.length === 0 ? (
            <p className="px-2 py-4 text-xs text-muted-foreground">
              {t("outline.empty_prefix")} <code className="font-mono">#</code>,{" "}
              <code className="font-mono">##</code>, <code className="font-mono">###</code>{" "}
              {t("outline.empty_suffix")}
            </p>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {headings.map((h, idx) => (
                <li key={`${h.line}-${idx}`}>
                  <button
                    type="button"
                    onClick={() => handleJump(h.line)}
                    className="block w-full truncate rounded px-2 py-1 text-left text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
                    style={{ paddingLeft: `${0.5 + (h.level - 1) * 0.75}rem` }}
                    title={h.text}
                  >
                    {h.text}
                  </button>
                </li>
              ))}
            </ul>
          )}

          <section className="mt-3 border-t border-border pt-3" aria-labelledby={`${id}-backlinks`}>
            <h2
              id={`${id}-backlinks`}
              className="px-2 pb-1 text-xs font-medium uppercase tracking-wider text-muted-foreground"
            >
              {t("knowledge.backlinks")}
            </h2>
            {backlinks.length === 0 ? (
              <p className="px-2 py-2 text-xs text-muted-foreground">
                {t("knowledge.backlinks_empty")}
              </p>
            ) : (
              <ul className="flex flex-col gap-0.5">
                {backlinks.map((entry) => (
                  <li key={entry.slug}>
                    <BacklinkButton entry={entry} onOpen={handleOpenNote} />
                  </li>
                ))}
              </ul>
            )}
            {dead.length > 0 && (
              <p className="px-2 pt-2 text-xs text-muted-foreground">
                {t("knowledge.dead_count", { n: dead.length })}
              </p>
            )}
            {showOrphan && (
              <p className="px-2 pt-1 text-xs text-muted-foreground/80">
                {t("knowledge.orphan_hint")}
              </p>
            )}
          </section>
        </div>
      </aside>
    </>
  );
}

function BacklinkButton({
  entry,
  onOpen,
}: {
  entry: NoteIndexEntry;
  onOpen: (slug: string) => void;
}) {
  const { t } = useI18n();
  const label = entry.title || entry.slug;
  return (
    <button
      type="button"
      onClick={() => onOpen(entry.slug)}
      className="block w-full truncate rounded px-2 py-1 text-left text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
      title={entry.slug}
      aria-label={t("knowledge.open_note", { slug: entry.slug })}
    >
      {label}
    </button>
  );
}
