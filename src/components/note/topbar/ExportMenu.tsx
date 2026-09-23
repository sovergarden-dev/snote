// Export dropdown: copy URL, download as .md/.html/.pdf/.txt, copy cleaned markdown for AI, copy raw markdown URL.
import { ChevronDown, Copy, Download, FileCode, FileType, Sparkles, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { exportMarkdown, exportPlainText, exportHtml, exportPdf } from "@/lib/export";
import { approxTokens, cleanForAI, resolveAiCopySource } from "@/lib/ai-format";
import { toast } from "@/hooks/use-toast";
import { useI18n } from "@/i18n";
import { CANONICAL_ORIGIN } from "@/lib/capability/url";

interface ExportMenuProps {
  slug: string;
  getContent: () => string;
  /** CodeMirror selection from the note editor only. Chrome/preview selection is ignored. */
  getEditorSelection?: () => string;
  isEncrypted: boolean;
}

export function ExportMenu({
  slug,
  getContent,
  getEditorSelection,
  isEncrypted,
}: ExportMenuProps) {
  const { t } = useI18n();

  const copyNoteUrl = async () => {
    await navigator.clipboard.writeText(window.location.href);
    toast({ title: t("toast.copied_url") });
  };

  const copyAsAI = async () => {
    const { text, fromSelection } = resolveAiCopySource(
      getEditorSelection?.() ?? "",
      getContent(),
    );
    if (!text) {
      toast({ title: t("toast.note_empty") });
      return;
    }
    const formatted = cleanForAI(text);
    await navigator.clipboard.writeText(formatted);
    toast({
      title: fromSelection ? t("toast.copied_ai_selection") : t("toast.copied_ai"),
      description: t("toast.copied_ai_desc", { n: approxTokens(formatted) }),
    });
  };

  const copyRawUrl = async () => {
    const url = `${CANONICAL_ORIGIN}/${slug}.md`;
    await navigator.clipboard.writeText(url);
    toast({ title: t("toast.copied_raw"), description: t("toast.copied_raw_desc") });
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-sm font-normal">
          {t("menu.export")}
          <ChevronDown className="h-3 w-3 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuItem onClick={copyNoteUrl}>
          <Copy className="h-3.5 w-3.5" /> {t("export.copy_url")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => exportMarkdown(slug, getContent())}>
          <Download className="h-3.5 w-3.5" /> {t("export.md")}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => exportHtml(slug, getContent())}>
          <FileCode className="h-3.5 w-3.5" /> {t("export.html")}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => exportPdf(slug, getContent())}>
          <FileType className="h-3.5 w-3.5" /> {t("export.pdf")}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => exportPlainText(slug, getContent())}>
          <Download className="h-3.5 w-3.5" /> {t("export.txt")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={copyAsAI} title={t("export.ai_tooltip")}>
          <Sparkles className="h-3.5 w-3.5" /> {t("export.ai")}
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={copyRawUrl}
          disabled={isEncrypted}
          title={t("export.raw_tooltip")}
        >
          <Terminal className="h-3.5 w-3.5" /> {t("export.raw")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
