/** @vitest-environment node */

import { readFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REQUIRED_KEYS = [
  "VITE_SUPABASE_PROJECT_ID",
  "VITE_SUPABASE_PUBLISHABLE_KEY",
  "VITE_SUPABASE_URL",
].sort();

const envEntries = readFileSync(resolve(process.cwd(), ".env"), "utf8")
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line.length > 0 && !line.startsWith("#"))
  .map((line) => {
    const separator = line.indexOf("=");
    if (separator === -1) return { name: "<malformed line>", value: "" };

    const rawValue = line.slice(separator + 1).trim();
    const value =
      (rawValue.startsWith('"') && rawValue.endsWith('"')) ||
      (rawValue.startsWith("'") && rawValue.endsWith("'"))
        ? rawValue.slice(1, -1)
        : rawValue;

    return { name: line.slice(0, separator).trim(), value };
  });

function hasAnonJwtRole(value: string): boolean {
  const segments = value.split(".");
  if (segments.length !== 3 || segments.some((segment) => segment.length === 0)) return false;

  try {
    const payload = JSON.parse(Buffer.from(segments[1], "base64url").toString("utf8")) as {
      role?: unknown;
    };
    return payload.role === "anon";
  } catch {
    return false;
  }
}

function isPublishableKey(value: string): boolean {
  const normalized = value.toLowerCase();
  if (normalized.includes("service_role") || normalized.includes("sb_secret_")) return false;

  return value.startsWith("sb_publishable_") || hasAnonJwtRole(value);
}

describe(".env security contract", () => {
  it("contains exactly the three approved Supabase variables", () => {
    expect(envEntries.map(({ name }) => name).sort()).toEqual(REQUIRED_KEYS);
  });

  it("does not contain a service-role or secret-key marker", () => {
    expect(
      envEntries.some(({ value }) => /service_role|sb_secret_/i.test(value)),
    ).toBe(false);
  });

  it("uses an anon JWT or sb_publishable_ key", () => {
    const publishableKey =
      envEntries.find(({ name }) => name === "VITE_SUPABASE_PUBLISHABLE_KEY")?.value ?? "";

    expect(isPublishableKey(publishableKey)).toBe(true);
  });
});
