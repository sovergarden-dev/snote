// Clean note markdown for pasting into AI tools (ChatGPT, Claude, Cursor, etc.).
// Strips noise to save tokens while keeping markdown structure intact.
// Clipboard body is cleaned markdown only — never a slug header.

/** Zero-width / invisible characters stripped from an AI copy slice. */
export const ZERO_WIDTH_CHARS = ["\u200B", "\u200C", "\u200D", "\uFEFF", "\u2060"] as const;

// Alternation, not a `[]` class: ZWNJ (U+200C) + ZWJ (U+200D) adjacent in a
// class trips `no-misleading-character-class` even though each code point is
// a separate alternative.
const ZERO_WIDTH_RE = new RegExp(ZERO_WIDTH_CHARS.join("|"), "g");

export function resolveAiCopySource(
  selection: string | undefined,
  fullNote: string,
): { text: string; fromSelection: boolean } {
  if ((selection ?? "").trim() !== "") {
    return { text: selection as string, fromSelection: true };
  }
  return { text: fullNote, fromSelection: false };
}

function isFenceLine(line: string): boolean {
  return line.trimStart().startsWith("```");
}

function tidyFenceTrailingSpaces(text: string): string {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!isFenceLine(lines[i])) continue;
    lines[i] = lines[i].replace(/[ \t]+$/, "");
    if (i + 1 < lines.length && !isFenceLine(lines[i + 1])) {
      lines[i + 1] = lines[i + 1].replace(/[ \t]+$/, "");
    }
    if (i > 0 && !isFenceLine(lines[i - 1])) {
      lines[i - 1] = lines[i - 1].replace(/[ \t]+$/, "");
    }
  }
  return lines.join("\n");
}

function closeUnclosedFence(text: string): string {
  const count = text.split("\n").filter(isFenceLine).length;
  if (count % 2 === 0) return text;
  return `${text.replace(/\s+$/, "")}\n\`\`\``;
}

export function cleanForAI(content: string): string {
  let text = content;
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  text = text.replace(ZERO_WIDTH_RE, "");
  text = text.replace(/<!--[\s\S]*?-->/g, "");
  text = text.replace(/[ \t]+$/gm, "");
  text = text.replace(/\n{3,}/g, "\n\n");
  text = tidyFenceTrailingSpaces(text);
  text = closeUnclosedFence(text);
  return text.trim();
}

// Approximate token count using the GPT rule-of-thumb (1 token ≈ 4 chars).
export function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
