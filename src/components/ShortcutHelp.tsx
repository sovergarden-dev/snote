import { Lightbulb } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useI18n } from "@/i18n/index";
import { modKeyLabel } from "@/lib/shortcut-hint";

interface ShortcutHelpProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex h-6 min-w-6 items-center justify-center rounded border border-border bg-muted px-1.5 font-mono text-[11px] font-medium text-foreground shadow-sm">
      {children}
    </kbd>
  );
}

export function ShortcutHelp({ open, onOpenChange }: ShortcutHelpProps) {
  const { t } = useI18n();
  const Mod = modKeyLabel();
  const sections: { title: string; items: { keys: string[]; label: string }[] }[] = [
    {
      title: t("shortcuts.section.nav"),
      items: [
        { keys: [Mod, "K"], label: t("shortcuts.label.cmdk") },
        { keys: [Mod, "P"], label: t("shortcuts.label.cmdk") },
        { keys: ["?"], label: t("shortcuts.label.help") },
        { keys: [Mod, "\\"], label: t("shortcuts.label.outline_toggle") },
        { keys: ["F11"], label: t("shortcuts.label.zen_toggle") },
        { keys: ["F9"], label: t("shortcuts.label.typewriter_toggle") },
      ],
    },
    {
      title: t("shortcuts.section.editor"),
      items: [
        { keys: [Mod, "F"], label: t("shortcuts.label.find") },
        { keys: [Mod, "Shift", "V"], label: t("shortcuts.label.preview_toggle") },
        { keys: [Mod, "Shift", "C"], label: t("shortcuts.label.copy_all") },
        { keys: [Mod, "Shift", "P"], label: t("shortcuts.label.page_toggle") },
        { keys: ["/"], label: t("shortcuts.label.slash") },
        { keys: ["#"], label: t("shortcuts.label.tag_autocomplete") },
      ],
    },
    {
      title: t("shortcuts.section.edit"),
      items: [
        { keys: [Mod, "Z"], label: t("shortcuts.label.undo") },
        { keys: [Mod, "Shift", "Z"], label: t("shortcuts.label.redo") },
      ],
    },
  ];

  const tips: { title: string; body: string }[] = [
    { title: t("shortcuts.tip.open_title"), body: t("shortcuts.tip.open_body") },
    { title: t("shortcuts.tip.pin_title"), body: t("shortcuts.tip.pin_body") },
    { title: t("shortcuts.tip.tag_title"), body: t("shortcuts.tip.tag_body") },
    { title: t("shortcuts.tip.split_title"), body: t("shortcuts.tip.split_body") },
    { title: t("shortcuts.tip.qr_title"), body: t("shortcuts.tip.qr_body") },
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="chrome-menu-surface max-h-[85vh] max-w-md overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("shortcuts.title")}</DialogTitle>
          <DialogDescription>
            {t("shortcuts.subtitle_press")} <Kbd>?</Kbd> {t("shortcuts.subtitle_reopen")}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-5">
          {sections.map((section) => (
            <div key={section.title}>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {section.title}
              </h3>
              <ul className="space-y-1.5">
                {section.items.map((item) => (
                  <li key={`${item.label}-${item.keys.join("-")}`} className="flex items-center justify-between gap-3 text-sm">
                    <span className="text-foreground">{item.label}</span>
                    <span className="flex items-center gap-1">
                      {item.keys.map((k, i) => (
                        <Kbd key={i}>{k}</Kbd>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}

          <div>
            <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              <Lightbulb className="h-3 w-3" />
              {t("shortcuts.section.tips")}
            </h3>
            <ul className="space-y-2.5">
              {tips.map((tip) => (
                <li key={tip.title} className="text-sm">
                  <div className="font-medium text-foreground">{tip.title}</div>
                  <div className="text-xs text-muted-foreground">{tip.body}</div>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
