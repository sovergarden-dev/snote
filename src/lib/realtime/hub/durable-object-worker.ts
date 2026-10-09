import { DurableObject } from "cloudflare:workers";
import {
  HubHealthDurableObject as HubHealthAdapter,
  RealtimeHubDurableObject as RealtimeHubAdapter,
  routeHubWorkerRequest,
  type DurableObjectContext,
  type DurableObjectSocket,
  type HubWorkerEnvironment,
} from "./durable-object-adapter";

export class RealtimeHubDurableObject extends DurableObject<HubWorkerEnvironment> {
  private readonly adapter: RealtimeHubAdapter;

  constructor(context: DurableObjectContext, environment: HubWorkerEnvironment) {
    super(context, environment);
    this.adapter = new RealtimeHubAdapter(context, environment);
  }

  fetch(request: Request): Promise<Response> {
    return this.adapter.fetch(request);
  }

  webSocketMessage(socket: DurableObjectSocket, message: string | ArrayBuffer): Promise<void> {
    return this.adapter.webSocketMessage(socket, message);
  }

  webSocketClose(socket: DurableObjectSocket): void {
    this.adapter.webSocketClose(socket);
  }

  webSocketError(socket: DurableObjectSocket): void {
    this.adapter.webSocketError(socket);
  }

  drain(windowMilliseconds?: number): Promise<void> {
    return this.adapter.drain(windowMilliseconds);
  }
}

export class HubHealthDurableObject extends DurableObject<HubWorkerEnvironment> {
  private readonly adapter: HubHealthAdapter;

  constructor(context: DurableObjectContext, environment: HubWorkerEnvironment) {
    super(context, environment);
    this.adapter = new HubHealthAdapter(context);
  }

  fetch(request: Request): Promise<Response> {
    return this.adapter.fetch(request);
  }

  isDraining(): Promise<boolean> {
    return this.adapter.isDraining();
  }

  setDraining(draining = true): Promise<void> {
    return this.adapter.setDraining(draining);
  }
}

export default {
  fetch(request: Request, environment: HubWorkerEnvironment): Promise<Response> {
    return routeHubWorkerRequest(request, environment);
  },
};
