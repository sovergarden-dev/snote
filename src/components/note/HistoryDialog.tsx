import { useEffect, useMemo, useState } from "react";
import * as Y from "yjs";
import { Clock, RotateCcw, Eye, GitCompare } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  listSnapshots,
  clearSnapshots,
  filterSnapshots,
  type Snapshot,
  type SnapshotKind,
  type SnapshotProtection,
} from "@/lib/snapshots";
import { applySelectedHunksToYText, clusterSnapshots, diffHunks, LIVE_TEXT_MISMATCH } from "@/lib/snapshot-history";
import { Trash2 } from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { SnapshotDiff } from "./SnapshotDiff";
import { useI18n } from "@/i18n/index";

interface HistoryDialogProps {
  slug: string;
  doc: Y.Doc;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  trigger?: boolean;
  snapshotProtection?: SnapshotProtection | null;
  readOnly?: boolean;
}

function formatTs(ts: number) {
  return new Date(ts).toLocaleString();
}

export function HistoryDialog({
  slug,
  doc,
  open: openProp,
  onOpenChange,
  trigger = true,
  snapshotProtection = null,
  readOnly = false,
}: HistoryDialogProps) {
  const { t } = useI18n();
  const [openInternal, setOpenInternal] = useState(false);
  const open = openProp ?? openInternal;
  const setOpen = (v: boolean) => {
    setOpenInternal(v);
    onOpenChange?.(v);
  };

  const timeAgo = (ts: number) => {
    const diff = Date.now() - ts;
    const m = Math.floor(diff / 60000);
    if (m < 1) return t("time.just_now");
    if (m < 60) return t("time.minutes_ago", { n: m });
    const h = Math.floor(m / 60);
    if (h < 24) return t("time.hours_ago", { n: h });
    const d = Math.floor(h / 24);
    return t("time.days_ago", { n: d });
  };

  const [items, setItems] = useState<Snapshot[]>([]);
  const [viewing, setViewing] = useState<Snapshot | null>(null);
  const [tab, setTab] = useState<"list" | "diff">("list");
  const [diffA, setDiffA] = useState<string>("");
  const [diffB, setDiffB] = useState<string>("");
  const [range, setRange] = useState<"all" | "day" | "week" | "month">("all");
  const [kind, setKind] = useState<"all" | SnapshotKind>("all");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  const rangeMs: Record<typeof range, number | null> = {
    all: null,
    day: 24 * 3600_000,
    week: 7 * 24 * 3600_000,
    month: 30 * 24 * 3600_000,
  };
  const filteredItems = filterSnapshots(items, { rangeMs: rangeMs[range], kind });
  const liveText = doc.getText("content").toString();
  const bursts = useMemo(
    () =>
      clusterSnapshots(filteredItems, {
        current: { ts: Date.now(), content: liveText },
        includeDistantCurrent: false,
      }),
    [filteredItems, liveText],
  );

  const handleClear = async () => {
    if (readOnly) return;
    const ok = window.confirm(t("history.confirm_clear", { n: items.length }));
    if (!ok) return;
    await clearSnapshots(slug);
    setItems([]);
    toast({ title: t("history.toast_cleared") });
  };

  useEffect(() => {
    if (!open) return;
    listSnapshots(slug, snapshotProtection).then((list) => {
      setItems(list);
      if (list.length > 0) {
        setDiffA(String(list[0].id ?? ""));
        setDiffB("__current__");
      }
    }).catch(() => setItems([]));
  }, [open, slug, snapshotProtection]);

  const restore = (snap: Snapshot) => {
    if (readOnly) return;
    const ok = window.confirm(
      t("history.confirm_restore", { ts: formatTs(snap.ts), chars: snap.charCount }),
    );
    if (!ok) return;
    const ytext = doc.getText("content");
    doc.transact(() => {
      ytext.delete(0, ytext.length);
      ytext.insert(0, snap.content);
    });
    toast({ title: t("history.toast_restored"), description: t("history.toast_restored_desc", { chars: snap.charCount }) });
    setOpen(false);
    setViewing(null);
  };

  const getContentFor = (id: string): { text: string; label: string } => {
    if (id === "__current__") {
      return { text: doc.getText("content").toString(), label: t("history.label_current") };
    }
    const snap = items.find((s) => String(s.id) === id);
    if (!snap) return { text: "", label: "?" };
    return { text: snap.content, label: timeAgo(snap.ts) };
  };

  const a = getContentFor(diffA);
  const b = getContentFor(diffB);
  const chars = t("history.chars_short");
  const canRestoreHunks = !readOnly && diffB === "__current__";
  const hunks = useMemo(() => diffHunks(a.text, b.text), [a.text, b.text]);

  useEffect(() => {
    setSelectedIds([]);
  }, [diffA, diffB, a.text, b.text]);

  const restoreHunks = () => {
    if (!canRestoreHunks || selectedIds.length === 0) return;
    const ok = window.confirm(t("history.confirm_restore_hunks", { n: selectedIds.length }));
    if (!ok) return;
    try {
      applySelectedHunksToYText(doc, {
        oldText: a.text,
        newText: b.text,
        hunks,
        selectedIds,
      });
    } catch (err) {
      if (err instanceof Error && err.message === LIVE_TEXT_MISMATCH) {
        toast({ title: t("history.hunk.stale") });
        return;
      }
      throw err;
    }
    toast({
      title: t("history.toast_hunks_restored"),
      description: t("history.toast_hunks_restored_desc", { n: selectedIds.length }),
    });
    setOpen(false);
  };

  const openBurstDiff = (oldestId: number | undefined) => {
    setDiffA(String(oldestId ?? ""));
    setDiffB("__current__");
    setTab("diff");
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {trigger && (
        <Tooltip>
          <TooltipTrigger asChild>
            <DialogTrigger asChild>
              <Button variant="ghost" size="icon" className="h-7 w-7" aria-label={t("history.aria")}>
                <Clock className="h-4 w-4" />
              </Button>
            </DialogTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">{t("history.tooltip")}</TooltipContent>
        </Tooltip>
      )}
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t("history.title")}</DialogTitle>
          <DialogDescription>{t("history.desc")}</DialogDescription>
        </DialogHeader>

        {viewing ? (
          <div className="space-y-3">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>
                {formatTs(viewing.ts)} • {viewing.charCount} {chars}
              </span>
              <Button variant="ghost" size="sm" onClick={() => setViewing(null)}>
                {t("history.back")}
              </Button>
            </div>
            <ScrollArea className="h-[50vh] rounded-md border border-border bg-muted/30 p-3">
              <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">
                {viewing.content}
              </pre>
            </ScrollArea>
            <div className="flex justify-end">
              <Button onClick={() => restore(viewing)} disabled={readOnly}>
                <RotateCcw className="h-4 w-4" />
                {t("history.restore_btn")}
              </Button>
            </div>
          </div>
        ) : items.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">{t("history.empty")}</p>
        ) : (
          <Tabs value={tab} onValueChange={(v) => setTab(v as "list" | "diff")}>
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="list">
                <Clock className="h-3.5 w-3.5" /> {t("history.tab.list")}
              </TabsTrigger>
              <TabsTrigger value="diff">
                <GitCompare className="h-3.5 w-3.5" /> {t("history.tab.diff")}
              </TabsTrigger>
            </TabsList>

            <TabsContent value="list">
              <div className="flex items-center justify-between gap-2 py-2">
                <div className="flex flex-wrap items-center gap-3">
                  <label className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span>{t("history.filter_range")}</span>
                    <select
                      value={range}
                      onChange={(e) => setRange(e.target.value as typeof range)}
                      className="rounded-md border border-border bg-background px-2 py-1 text-xs"
                      data-history-range-filter
                    >
                      <option value="all">{t("history.range.all")}</option>
                      <option value="day">{t("history.range.day")}</option>
                      <option value="week">{t("history.range.week")}</option>
                      <option value="month">{t("history.range.month")}</option>
                    </select>
                  </label>
                  <label className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span>{t("history.filter_kind")}</span>
                    <select
                      value={kind}
                      onChange={(e) => setKind(e.target.value as typeof kind)}
                      className="rounded-md border border-border bg-background px-2 py-1 text-xs"
                      data-history-kind-filter
                    >
                      <option value="all">{t("history.kind.all")}</option>
                      <option value="periodic">{t("history.kind.periodic")}</option>
                      <option value="sudden_delete">{t("history.kind.sudden_delete")}</option>
                    </select>
                  </label>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleClear}
                  disabled={readOnly}
                  className="text-destructive hover:text-destructive"
                  data-history-clear
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  {t("history.clear")}
                </Button>
              </div>
              <ScrollArea className="max-h-[55vh]">
                <div className="divide-y divide-border">
                  {bursts.map((burst) => (
                    <section key={burst.id} className="py-3">
                      <div className="mb-2 flex items-center justify-between gap-2">
                        <div className="min-w-0 text-xs text-muted-foreground">
                          <span className="font-medium text-foreground">{t("history.burst.heading")}</span>
                          {" · "}
                          <span>{t("history.burst.n_snapshots", { n: burst.snapshots.length })}</span>
                          {burst.vsCurrent ? (
                            <>
                              {" · "}
                              <span>{t("history.burst.vs_current")}</span>
                            </>
                          ) : null}
                        </div>
                        <Button
                          variant="ghost"
                          size="sm"
                          data-history-compare-burst
                          onClick={() => openBurstDiff(burst.snapshots[0]?.id)}
                        >
                          <GitCompare className="h-3.5 w-3.5" />
                          {t("history.burst.compare")}
                        </Button>
                      </div>
                      <ul>
                        {burst.snapshots.slice().reverse().map((snap) => (
                          <li key={snap.id} className="flex items-start gap-3 py-2">
                            <div className="min-w-0 flex-1">
                              <div className="flex items-baseline gap-2">
                                <span className="text-sm font-medium">{timeAgo(snap.ts)}</span>
                                <span className="text-[11px] text-muted-foreground">
                                  {formatTs(snap.ts)} • {snap.charCount} {chars}
                                </span>
                              </div>
                              <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                                {snap.preview || <em>{t("history.preview_empty")}</em>}
                              </p>
                            </div>
                            <div className="flex shrink-0 gap-1">
                              <Button variant="ghost" size="sm" onClick={() => setViewing(snap)}>
                                <Eye className="h-3.5 w-3.5" />
                                {t("history.view")}
                              </Button>
                              <Button variant="outline" size="sm" onClick={() => restore(snap)} disabled={readOnly}>
                                <RotateCcw className="h-3.5 w-3.5" />
                                {t("history.restore")}
                              </Button>
                            </div>
                          </li>
                        ))}
                      </ul>
                    </section>
                  ))}
                </div>
              </ScrollArea>
            </TabsContent>

            <TabsContent value="diff" className="space-y-3">
              <div className="grid grid-cols-2 gap-3 text-xs">
                <label className="space-y-1">
                  <span className="text-muted-foreground">{t("history.label_old")}</span>
                  <select
                    value={diffA}
                    onChange={(e) => setDiffA(e.target.value)}
                    className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs"
                  >
                    {items.map((s) => (
                      <option key={s.id} value={String(s.id)}>
                        {timeAgo(s.ts)} ({s.charCount} {chars})
                      </option>
                    ))}
                  </select>
                </label>
                <label className="space-y-1">
                  <span className="text-muted-foreground">{t("history.label_new")}</span>
                  <select
                    value={diffB}
                    onChange={(e) => setDiffB(e.target.value)}
                    className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs"
                    data-history-diff-new
                    data-testid="history-diff-new"
                  >
                    <option value="__current__">{t("history.option_current")}</option>
                    {items.map((s) => (
                      <option key={s.id} value={String(s.id)}>
                        {timeAgo(s.ts)} ({s.charCount} {chars})
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <SnapshotDiff
                oldText={a.text}
                newText={b.text}
                oldLabel={a.label}
                newLabel={b.label}
                selectable={canRestoreHunks}
                selectedIds={selectedIds}
                onToggleHunk={(id, selected) => {
                  setSelectedIds((prev) => {
                    if (selected) return prev.includes(id) ? prev : [...prev, id];
                    return prev.filter((x) => x !== id);
                  });
                }}
                onToggleAll={(selected) => {
                  setSelectedIds(selected ? hunks.map((h) => h.id) : []);
                }}
              />
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs text-muted-foreground">
                  {canRestoreHunks ? null : t("history.hunk.need_current")}
                </p>
                <Button
                  onClick={restoreHunks}
                  disabled={!canRestoreHunks || selectedIds.length === 0}
                  data-history-restore-hunks
                >
                  <RotateCcw className="h-4 w-4" />
                  {selectedIds.length > 0
                    ? t("history.hunk.restore_n", { n: selectedIds.length })
                    : t("history.hunk.restore")}
                </Button>
              </div>
            </TabsContent>
          </Tabs>
        )}
      </DialogContent>
    </Dialog>
  );
}
