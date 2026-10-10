import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createNodeHubServerWithVolume, installNodeSigtermDrain, type NodeVolumeHubServer } from "./node-adapter";
import { importHubPinnedKeys } from "./keyring";
import type { NodeHubVolumeOptions } from "./node-adapter";

export const RT1_REPLAY_VOLUME_ROOT = "/var/lib/snote-rt1";
export const RT1_EXPECTED_LISTEN_ADDRESS = "0.0.0.0";

export interface Rt1HubEnvironment {
  config: NodeHubVolumeOptions["config"];
  replayDatabasePath: string;
  listenAddress: string;
  port: number;
  drainWindowMilliseconds: number;
}

function requiredEnvironmentValue(environment: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = environment[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("Missing required rt1 configuration");
  }
  return value;
}

function parseInteger(value: string, minimum: number, maximum: number): number {
  if (!/^(0|[1-9][0-9]*)$/u.test(value)) throw new Error("Invalid rt1 configuration");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error("Invalid rt1 configuration");
  }
  return parsed;
}

function parseReplayDatabasePath(value: string): string {
  if (!isAbsolute(value)) throw new Error("Invalid replay storage configuration");
  const normalized = resolve(value);
  if (normalized !== value || !normalized.startsWith(`${RT1_REPLAY_VOLUME_ROOT}/`)) {
    throw new Error("Invalid replay storage configuration");
  }
  return normalized;
}

/**
 * Read only the approved, non-secret Hub settings passed by Compose from the
 * operator-owned VM environment file. Private signing, HMAC, and master keys
 * are intentionally not part of this runtime contract.
 */
export async function loadRt1HubConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<Rt1HubEnvironment> {
  const hubId = requiredEnvironmentValue(environment, "HUB_ID");
  const ticketProbePublicKeys = requiredEnvironmentValue(environment, "TICKET_PROBE_PUBLIC_KEYS_JSON");
  const savedAckPublicKeys = requiredEnvironmentValue(environment, "SAVED_ACK_PUBLIC_KEYS_JSON");
  const listenAddress = requiredEnvironmentValue(environment, "HUB_LISTEN_ADDRESS");
  const portText = requiredEnvironmentValue(environment, "HUB_PORT");
  const drainWindowText = requiredEnvironmentValue(environment, "HUB_DRAIN_WINDOW_MS");
  const replayDatabasePathText = requiredEnvironmentValue(environment, "HUB_REPLAY_DATABASE_PATH");

  if (listenAddress !== RT1_EXPECTED_LISTEN_ADDRESS) {
    throw new Error("Invalid rt1 listener address");
  }

  let pinnedKeys;
  try {
    pinnedKeys = await importHubPinnedKeys({
      HUB_ID: hubId,
      TICKET_PROBE_PUBLIC_KEYS_JSON: ticketProbePublicKeys,
      SAVED_ACK_PUBLIC_KEYS_JSON: savedAckPublicKeys,
    });
  } catch {
    throw new Error("Invalid rt1 public-key configuration");
  }

  return {
    config: { hubId, pinnedKeys },
    listenAddress,
    port: parseInteger(portText, 1, 65_535),
    drainWindowMilliseconds: parseInteger(drainWindowText, 0, 30_000),
    replayDatabasePath: parseReplayDatabasePath(replayDatabasePathText),
  };
}

export async function createRt1HubServerFromEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  createServer: (options: NodeHubVolumeOptions) => Promise<NodeVolumeHubServer> = createNodeHubServerWithVolume,
): Promise<{ server: NodeVolumeHubServer; listenAddress: string; port: number }> {
  const { listenAddress, port, ...serverOptions } = await loadRt1HubConfig(environment);
  return { server: await createServer(serverOptions), listenAddress, port };
}

function assertSupportedNodeVersion(): void {
  const parts = process.versions.node.split(".").map(Number);
  const major = parts[0] ?? 0;
  const minor = parts[1] ?? 0;
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || major < 22 || (major === 22 && minor < 22)) {
    throw new Error("Unsupported Node runtime");
  }
}

export async function startRt1HubFromEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<NodeVolumeHubServer> {
  assertSupportedNodeVersion();
  const { server, listenAddress, port } = await createRt1HubServerFromEnvironment(environment);
  try {
    await new Promise<void>((resolveListening, reject) => {
      const cleanup = () => {
        server.off("listening", onListening);
        server.off("error", onError);
      };
      const onListening = () => {
        cleanup();
        resolveListening();
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      server.once("listening", onListening);
      server.once("error", onError);
      try {
        server.listen(port, listenAddress);
      } catch (error) {
        cleanup();
        reject(error);
      }
    });
    return server;
  } catch {
    server.closeStorage();
    throw new Error("Unable to start rt1 hub");
  }
}

export async function runRt1HubProcess(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> {
  const server = await startRt1HubFromEnvironment(environment);
  await new Promise<void>((resolveShutdown, rejectShutdown) => {
    let removeSignalHandler: () => void = () => {};
    removeSignalHandler = installNodeSigtermDrain(server, (error) => {
      removeSignalHandler();
      if (error) rejectShutdown(new Error("Unable to drain rt1 hub"));
      else resolveShutdown();
    });
  });
}

const scriptPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (scriptPath !== "" && pathToFileURL(scriptPath).href === import.meta.url) {
  void runRt1HubProcess().catch(() => {
    process.stderr.write("rt1 hub failed\n");
    process.exitCode = 1;
  });
}
