import { importHubPinnedKeys, type HubKeyBindings } from "../../src/lib/realtime/hub/keyring";
import {
  routeHubWorkerRequest,
  type HubWorkerEnvironment,
} from "../../src/lib/realtime/hub/durable-object-adapter";

export {
  HubHealthDurableObject,
  RealtimeHubDurableObject,
} from "../../src/lib/realtime/hub/durable-object-worker";

const configurationChecks = new WeakMap<object, Promise<boolean>>();

function hasValidConfiguration(environment: HubKeyBindings): Promise<boolean> {
  const identity = environment as object;
  const cached = configurationChecks.get(identity);
  if (cached) return cached;

  const check = importHubPinnedKeys(environment).then(
    () => true,
    () => false,
  );
  configurationChecks.set(identity, check);
  return check;
}

export default {
  async fetch(request: Request, environment: HubWorkerEnvironment): Promise<Response> {
    if (!await hasValidConfiguration(environment)) {
      return new Response(null, {
        status: 503,
        headers: { "cache-control": "no-store" },
      });
    }
    return routeHubWorkerRequest(request, environment);
  },
};
