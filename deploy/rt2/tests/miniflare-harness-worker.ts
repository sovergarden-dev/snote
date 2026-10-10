import { DurableObject } from "cloudflare:workers";
import rt2Worker, {
  HubHealthDurableObject,
  RealtimeHubDurableObject,
} from "../worker";
import {
  RealtimeHubDurableObject as RealtimeHubAdapter,
  type DurableObjectContext,
  type DurableObjectSocket,
  type HubWorkerEnvironment,
} from "../../../src/lib/realtime/hub/durable-object-adapter";
import type { HubKeyBindings } from "../../../src/lib/realtime/hub/keyring";
import { HUB_REPLAY_TABLE } from "../../../src/lib/realtime/hub/replay-store";

export { HubHealthDurableObject, RealtimeHubDurableObject };

interface TestEnvironment extends HubWorkerEnvironment {
  ROOM_HUB_TEST: HubWorkerEnvironment["ROOM_HUB"];
}

interface TestRequestBody {
  roomId?: unknown;
  sessionId?: unknown;
  ticket?: unknown;
}

interface TicketResult {
  accepted: boolean;
  messageTypes: string[];
  closeCode?: number;
  closeReason?: string;
}

interface TestRoomHubStub {
  authorize(ticket: string, roomId: string, sessionId: string): Promise<TicketResult>;
  drain(): Promise<{ drained: boolean; messageTypes: string[] }>;
  corruptReplayStore(): Promise<void>;
}

interface TestHealthStub {
  setDraining(draining?: boolean): Promise<void>;
}

class CapturingSocket {
  readyState = WebSocket.OPEN;
  private attachment: unknown;
  readonly sentMessages: string[] = [];
  closeCode?: number;
  closeReason?: string;

  serializeAttachment(value: unknown): void {
    this.attachment = structuredClone(value);
  }

  deserializeAttachment(): unknown {
    return this.attachment === undefined ? undefined : structuredClone(this.attachment);
  }

  send(data: string): void {
    if (this.readyState !== WebSocket.OPEN || typeof data !== "string") {
      throw new Error("Test socket accepts only open text frames");
    }
    this.sentMessages.push(data);
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState !== WebSocket.OPEN) return;
    this.readyState = WebSocket.CLOSED;
    this.closeCode = code;
    this.closeReason = reason;
  }
}

function messageTypes(messages: readonly string[]): string[] {
  return messages.flatMap((message) => {
    try {
      const type = (JSON.parse(message) as Record<string, unknown>).message_type;
      return typeof type === "string" ? [type] : [];
    } catch {
      return [];
    }
  });
}

function jsonResponse(value: Record<string, unknown>, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

/** Test-only DO: shared adapter/core over Miniflare's real SQLite DO storage. */
export class MiniflareContractDurableObject extends DurableObject<HubWorkerEnvironment> {
  private readonly sockets: CapturingSocket[] = [];
  private readonly adapter: RealtimeHubAdapter;
  private readonly sql: DurableObjectContext["storage"]["sql"];

  constructor(state: DurableObjectContext, environment: HubWorkerEnvironment) {
    super(state as never, environment);
    this.sql = state.storage.sql;
    const context: DurableObjectContext = {
      storage: state.storage,
      acceptWebSocket: (socket) => {
        this.sockets.push(socket as unknown as CapturingSocket);
      },
      getWebSockets: () => this.sockets
        .filter((socket) => socket.readyState === WebSocket.OPEN)
        .map((socket) => socket as unknown as DurableObjectSocket),
    };
    this.adapter = new RealtimeHubAdapter(context, environment as HubKeyBindings);
  }

  async authorize(ticket: string, roomId: string, sessionId: string): Promise<TicketResult> {
    const socket = new CapturingSocket();
    socket.serializeAttachment({ room_id: roomId, auth_deadline_ms: Date.now() + 5_000 });
    this.sockets.push(socket);
    await this.adapter.webSocketMessage(
      socket as unknown as DurableObjectSocket,
      JSON.stringify({
        v: 2,
        message_type: "hub-auth",
        opaque_room_id: roomId,
        payload: { ticket, session_id: sessionId },
      }),
    );
    const types = messageTypes(socket.sentMessages);
    return {
      accepted: types.includes("hub-ready"),
      messageTypes: types,
      ...(socket.closeCode === undefined ? {} : { closeCode: socket.closeCode }),
      ...(socket.closeReason ? { closeReason: socket.closeReason } : {}),
    };
  }

  async drain(): Promise<{ drained: boolean; messageTypes: string[] }> {
    await this.adapter.drain(0);
    const socket = this.sockets.at(-1);
    const types = socket ? messageTypes(socket.sentMessages) : [];
    return {
      drained: types.includes("drain") && socket?.closeCode === 1001,
      messageTypes: types,
    };
  }

  async corruptReplayStore(): Promise<void> {
    this.sql.exec(`DROP TABLE IF EXISTS ${HUB_REPLAY_TABLE}`);
    this.sql.exec(
      `CREATE TABLE ${HUB_REPLAY_TABLE} (
        unrelated_key TEXT NOT NULL PRIMARY KEY
      ) STRICT`,
    );
  }
}

async function readBody(request: Request): Promise<TestRequestBody | undefined> {
  try {
    const body: unknown = await request.json();
    return typeof body === "object" && body !== null && !Array.isArray(body)
      ? body as TestRequestBody
      : undefined;
  } catch {
    return undefined;
  }
}

function validBody(body: TestRequestBody | undefined): body is Required<TestRequestBody> {
  return typeof body?.roomId === "string"
    && /^[A-Za-z0-9_-]{1,128}$/u.test(body.roomId)
    && typeof body.sessionId === "string"
    && /^[A-Za-z0-9_-]{8,128}$/u.test(body.sessionId)
    && typeof body.ticket === "string"
    && body.ticket.length > 0;
}

export default {
  async fetch(request: Request, environment: TestEnvironment): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/__test/store-failure") {
      const body = await readBody(request);
      if (typeof body?.roomId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(body.roomId)) {
        return jsonResponse({ prepared: false }, 400);
      }
      const roomHub = environment.ROOM_HUB_TEST.get(
        environment.ROOM_HUB_TEST.idFromName(body.roomId),
      ) as unknown as TestRoomHubStub;
      await roomHub.corruptReplayStore();
      return jsonResponse({ prepared: true });
    }
    if (request.method === "POST" && (url.pathname === "/__test/open" || url.pathname === "/__test/drain")) {
      const body = await readBody(request);
      if (!validBody(body)) return jsonResponse({ accepted: false, drained: false }, 400);

      const roomHub = environment.ROOM_HUB_TEST.get(
        environment.ROOM_HUB_TEST.idFromName(body.roomId),
      ) as unknown as TestRoomHubStub;
      const authorization = await roomHub.authorize(body.ticket, body.roomId, body.sessionId);
      if (url.pathname === "/__test/open") return jsonResponse(authorization);
      if (!authorization.accepted) {
        return jsonResponse({ accepted: false, drained: false, messageTypes: authorization.messageTypes });
      }

      const drain = await roomHub.drain();
      const health = environment.HUB_HEALTH.get(
        environment.HUB_HEALTH.idFromName("hub-health-v1"),
      ) as unknown as TestHealthStub;
      await health.setDraining(true);
      return jsonResponse({ accepted: true, ...drain });
    }
    return rt2Worker.fetch(request, environment);
  },
};
