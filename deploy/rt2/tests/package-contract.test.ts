import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parse } from "smol-toml";

type TomlObject = Record<string, unknown>;

function object(value: unknown): TomlObject {
  return typeof value === "object" && value !== null ? value as TomlObject : {};
}

function allKeys(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  return Object.entries(value as TomlObject).flatMap(([key, nested]) => [
    prefix ? `${prefix}.${key}` : key,
    ...allKeys(nested, prefix ? `${prefix}.${key}` : key),
  ]);
}

describe("rt2 package contract", () => {
  it("uses an isolated, pinned Workers Free configuration with SQLite DO migration", async () => {
    const configUrl = new URL("../wrangler.toml", import.meta.url);
    const source = await readFile(configUrl, "utf8");
    const config = object(parse(source));

    expect(config.name).toBe("snote-realtime-rt2");
    expect(config.main).toBe("worker.ts");
    expect(config.compatibility_date).toBe("2026-08-06");
    expect(config.workers_dev).toBe(false);

    const forbiddenKeys = allKeys(config).filter((key) =>
      /(?:^|\.)(?:account_id|zone_id|route|routes|custom_domain|custom_domains|hostname)(?:$|\.)/iu.test(key)
    );
    expect(forbiddenKeys).toEqual([]);
    expect(source).not.toMatch(/[0-9a-f]{32}/iu);
    expect(source).not.toContain("syrin.online");

    const durableObjects = object(config.durable_objects);
    const bindings = durableObjects.bindings as TomlObject[];
    expect(bindings).toEqual([
      { name: "ROOM_HUB", class_name: "RealtimeHubDurableObject" },
      { name: "HUB_HEALTH", class_name: "HubHealthDurableObject" },
    ]);
    expect(config.migrations).toEqual([{
      tag: "v1-sqlite-durable-objects",
      new_sqlite_classes: ["RealtimeHubDurableObject", "HubHealthDurableObject"],
    }]);

    const observability = object(config.observability);
    const logs = object(observability.logs);
    const traces = object(observability.traces);
    expect(observability.enabled).toBe(false);
    expect(logs.enabled).toBe(false);
    expect(logs.invocation_logs).toBe(false);
    expect(traces.enabled).toBe(false);

    expect(config.vars).toEqual({
      HUB_ID: "rt2",
      TICKET_PROBE_PUBLIC_KEYS_JSON: "{}",
      SAVED_ACK_PUBLIC_KEYS_JSON: "{}",
    });
  });

  it("imports the shared runtime without depending on cloudflare-worker/", async () => {
    const workerSource = await readFile(new URL("../worker.ts", import.meta.url), "utf8");
    expect(workerSource).not.toMatch(/from\s+["'][^"']*cloudflare-worker\//u);
    expect(workerSource).not.toContain("cloudflare-worker/");
  });
});

export const RT2_CONFIG_PATH = fileURLToPath(new URL("../wrangler.toml", import.meta.url));
