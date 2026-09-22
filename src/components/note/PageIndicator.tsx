import { ChevronUp, ChevronDown } from "lucide-react";
import { useI18n } from "@/i18n/index";

interface PageIndicatorProps {
  page: number;
  totalPages: number;
  onPrev: () => void;
  onNext: () => void;
}

export function PageIndicator({ page, totalPages, onPrev, onNext }: PageIndicatorProps) {
  const { t } = useI18n();
  return (
    <div
      className="snote-page-indicator pointer-events-auto z-40 flex items-center gap-1 rounded-full border border-border bg-background/90 px-2 py-1 text-[11px] font-medium text-muted-foreground shadow-sm backdrop-blur tabular-nums"
      role="status"
      aria-live="polite"
      aria-label={t("page.aria", { page, total: totalPages })}
    >
      <button
        type="button"
        onClick={onPrev}
        disabled={page <= 1}
        aria-label={t("page.prev")}
        className="flex h-5 w-5 items-center justify-center rounded-full hover:bg-accent hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent"
      >
        <ChevronUp className="h-3 w-3" />
      </button>
      <span className="px-1">
        {t("page.label")} {page} / {totalPages}
      </span>
      <button
        type="button"
        onClick={onNext}
        disabled={page >= totalPages}
        aria-label={t("page.next")}
        className="flex h-5 w-5 items-center justify-center rounded-full hover:bg-accent hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent"
      >
        <ChevronDown className="h-3 w-3" />
      </button>
    </div>
  );
}
