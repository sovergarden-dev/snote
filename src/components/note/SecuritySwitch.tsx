import { cn } from "@/lib/utils";

export function SecuritySwitch({
  checked,
  disabled = false,
  labelledBy,
  describedBy,
  onCheckedChange,
}: {
  checked: boolean;
  disabled?: boolean;
  labelledBy: string;
  describedBy?: string;
  onCheckedChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      aria-disabled={disabled || undefined}
      disabled={disabled}
      className={cn(
        "relative inline-flex h-11 min-h-11 w-11 min-w-11 shrink-0 items-center justify-center rounded-full",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        disabled && "cursor-not-allowed opacity-50",
      )}
      onClick={() => onCheckedChange(!checked)}
    >
      <span
        aria-hidden
        data-state={checked ? "checked" : "unchecked"}
        className={cn(
          "relative h-7 w-11 overflow-hidden rounded-full border",
          "motion-safe:transition-colors motion-reduce:transition-none",
          checked ? "border-primary bg-primary" : "border-border bg-muted",
        )}
      >
        <span
          data-testid="security-switch-thumb"
          className={cn(
            "absolute top-1/2 h-6 w-6 -translate-y-1/2 rounded-full shadow",
            "motion-safe:transition-transform motion-reduce:transition-none",
            checked
              ? "left-0.5 translate-x-4 bg-primary-foreground"
              : "left-0.5 translate-x-0 bg-foreground",
          )}
        />
      </span>
    </button>
  );
}
