import { cn } from "@/lib/utils";

export function SecuritySwitch({
  checked,
  disabled = false,
  labelledBy,
  onCheckedChange,
}: {
  checked: boolean;
  disabled?: boolean;
  labelledBy: string;
  onCheckedChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={labelledBy}
      disabled={disabled}
      className={cn(
        "relative inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        disabled && "cursor-not-allowed opacity-50",
      )}
      onClick={() => onCheckedChange(!checked)}
    >
      <span
        aria-hidden
        className={cn(
          "relative h-7 w-11 rounded-full border transition-colors",
          checked ? "border-foreground bg-foreground" : "border-border bg-muted",
        )}
      >
        <span
          className={cn(
            "absolute top-0.5 h-6 w-6 rounded-full bg-background shadow transition-transform",
            checked ? "translate-x-4" : "translate-x-0.5",
          )}
        />
      </span>
    </button>
  );
}
