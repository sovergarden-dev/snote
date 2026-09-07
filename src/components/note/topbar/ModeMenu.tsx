// Mode dropdown: Zen, Typewriter, Focus line, Page mode, Vim mode + E-ink radio group.
import {
  AlignVerticalJustifyCenter,
  BookOpen,
  ChevronDown,
  Highlighter,
  Maximize2,
  MonitorSmartphone,
  Terminal,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useEink } from "@/hooks/use-eink";
import { useVimMode } from "@/hooks/use-vim-mode";
import { useI18n } from "@/i18n";
import { formatModShortcut } from "@/lib/shortcut-hint";

interface ModeMenuProps {
  zen: boolean;
  onToggleZen: () => void;
  typewriter: boolean;
  onToggleTypewriter: () => void;
  focusLine: boolean;
  onToggleFocusLine: () => void;
  paginated: boolean;
  onTogglePagination: () => void;
}

export function ModeMenu({
  zen,
  onToggleZen,
  typewriter,
  onToggleTypewriter,
  focusLine,
  onToggleFocusLine,
  paginated,
  onTogglePagination,
}: ModeMenuProps) {
  const { pref: einkPref, setMode: setEinkMode } = useEink();
  const { vim, toggleVim } = useVimMode();
  const { t } = useI18n();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-sm font-normal">
          {t("menu.mode")}
          <ChevronDown className="h-3 w-3 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuItem onClick={onToggleZen} className="items-start py-2">
          <Maximize2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <div className="flex min-w-0 flex-1 flex-col">
            <span>{zen ? t("mode.zen.exit") : t("mode.zen.enter")}</span>
            <span className="text-[11px] text-foreground/80">{t("mode.zen.desc")}</span>
          </div>
          <span className="ml-auto self-start text-[10px] text-muted-foreground">F11</span>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onToggleTypewriter} className="items-start py-2">
          <AlignVerticalJustifyCenter className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <div className="flex min-w-0 flex-1 flex-col">
            <span>{typewriter ? t("mode.typewriter.exit") : t("mode.typewriter.enter")}</span>
            <span className="text-[11px] text-foreground/80">{t("mode.typewriter.desc")}</span>
          </div>
          <span className="ml-auto self-start text-[10px] text-muted-foreground">F9</span>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onToggleFocusLine} className="items-start py-2">
          <Highlighter className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <div className="flex min-w-0 flex-1 flex-col">
            <span>{focusLine ? t("mode.focus.disable") : t("mode.focus.enable")}</span>
            <span className="text-[11px] text-foreground/80">{t("mode.focus.desc")}</span>
          </div>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onTogglePagination} className="items-start py-2">
          <BookOpen className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <div className="flex min-w-0 flex-1 flex-col">
            <span>{paginated ? t("mode.page.disable") : t("mode.page.enable")}</span>
            <span className="text-[11px] text-foreground/80">{t("mode.page.desc")}</span>
          </div>
          <span className="ml-auto self-start text-[10px] text-muted-foreground">{formatModShortcut(["Shift", "P"])}</span>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={toggleVim} className="items-start py-2">
          <Terminal className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <div className="flex min-w-0 flex-1 flex-col">
            <span>{vim ? t("mode.vim.disable") : t("mode.vim.enable")}</span>
            <span className="text-[11px] text-foreground/80">{t("mode.vim.desc")}</span>
          </div>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="flex flex-col gap-0.5 text-xs">
          <span className="flex items-center gap-2">
            <MonitorSmartphone className="h-3.5 w-3.5" />
            {t("mode.eink.label")}
          </span>
          <span className="pl-5 text-[11px] font-normal text-foreground/80">{t("mode.eink.desc")}</span>
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={einkPref}
          onValueChange={(v) => setEinkMode(v as "auto" | "on" | "off")}
        >
          <DropdownMenuRadioItem value="auto">{t("mode.eink.auto")}</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="on">{t("mode.eink.on")}</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="off">{t("mode.eink.off")}</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
