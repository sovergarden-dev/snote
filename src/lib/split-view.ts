export const MIN_SPLIT_PANES = 2;
export const MAX_SPLIT_PANES = 4;
export const SPLIT_SLUG_RE = /^[a-zA-Z0-9_-]{1,64}$/;

export function parseSplitSlugs(param: string): string[] {
  return param.split("+").filter(Boolean);
}

export function splitHasDuplicateSlugs(slugs: readonly string[]): boolean {
  return slugs.length !== new Set(slugs).size;
}

/** Compact tab label. Duplicate slugs get `/{slug} · N` (E2); unique stay `/{slug}` (G2). */
export function splitPaneTabLabel(slugs: readonly string[], index: number): string {
  const slug = slugs[index];
  if (!slug) return "";
  const duplicate = slugs.filter((candidate) => candidate === slug).length > 1;
  if (!duplicate) return `/${slug}`;
  const ordinal = slugs.slice(0, index + 1).filter((candidate) => candidate === slug).length;
  return `/${slug} · ${ordinal}`;
}

export function splitPaneKey(index: number): string {
  return `pane-${index}`;
}
