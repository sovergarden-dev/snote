import {
  decodeBase64Url,
  decodeRealtimeFrame,
  MAX_REALTIME_FRAME_BYTES,
  type JwsPinnedKeySets,
  type RealtimeFrame,
  verifyProtocolJws,
} from "../protocol";
import type { HubClock } from "./clock";
import { nowSeconds, systemHubClock } from "./clock";
import type { ReplayStore } from "./replay-store";

const AUTH_MESSAGE = "hub-auth";
const AUTH_TIMEOUT_CLOSE_CODE = 4408;
const POLICY_CLOSE_CODE = 1008;
const INTERNAL_CLOSE_CODE = 1011;
const TOO_LARGE_CLOSE_CODE = 1009;
const VALID_SESSION_ID = /^[A-Za-z0-9_-]{8,128}$/u;
const MAX_OPAQUE_ROOM_ID_LENGTH = 128;
const ALLOWED_RELAY_TYPES = new Set(["y-update", "presence", "save", "saved-ack"]);

export interface HubRuntimeConfig {
  hubId: string;
  pinnedKeys: JwsPinnedKeySets;
  clock?: HubClock;
}

export interface HubSocketAttachment {
  room_id: string;
  generation: number;
  assignment_epoch: number;
  permission_epoch: number;
  permission: "read" | "edit";
  permissions: readonly ("read" | "write")[];
  session_id: string;
  ticket_expires_at: number;
  renewal_counter: number;
}

/** The adapters own I/O; the shared core never retains frame or ticket bytes. */
export interface HubSocketPeer {
  isOpen(): boolean;
  getAttachment(): unknown;
  setAttachment(attachment: HubSocketAttachment): void;
  send(text: string): void;
  close(code: number, reason: string): void;
}

export function isOpaqueRoomId(value: string): boolean {
  return value.length > 0 && value.length <= MAX_OPAQUE_ROOM_ID_LENGTH && /^[A-Za-z0-9_-]+$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getAttachment(value: unknown): HubSocketAttachment | undefined {
  if (!isRecord(value)) return undefined;
  const permission = value.permission;
  const permissions = value.permissions;
  if (
    typeof value.room_id !== "string"
    || !isOpaqueRoomId(value.room_id)
    || !Number.isSafeInteger(value.generation)
    || (value.generation as number) < 1
    || !Number.isSafeInteger(value.assignment_epoch)
    || (value.assignment_epoch as number) < 0
    || !Number.isSafeInteger(value.permission_epoch)
    || (value.permission_epoch as number) < 0
    || (permission !== "read" && permission !== "edit")
    || !Array.isArray(permissions)
    || !permissions.every((item) => item === "read" || item === "write")
    || typeof value.session_id !== "string"
    || !VALID_SESSION_ID.test(value.session_id)
    || !Number.isSafeInteger(value.ticket_expires_at)
    || (value.ticket_expires_at as number) < 0
    || !Number.isSafeInteger(value.renewal_counter)
    || (value.renewal_counter as number) < 0
  ) {
    return undefined;
  }
  const normalizedPermissions = permissions.slice();
  if (
    (permission === "read" && (normalizedPermissions.length !== 1 || normalizedPermissions[0] !== "read"))
    || (permission === "edit" && (normalizedPermissions.length !== 2 || normalizedPermissions[0] !== "read" || normalizedPermissions[1] !== "write"))
  ) {
    return undefined;
  }
  return {
    room_id: value.room_id,
    generation: value.generation as number,
    assignment_epoch: value.assignment_epoch as number,
    permission_epoch: value.permission_epoch as number,
    permission,
    permissions: normalizedPermissions as ("read" | "write")[],
    session_id: value.session_id,
    ticket_expires_at: value.ticket_expires_at as number,
    renewal_counter: value.renewal_counter as number,
  };
}

function payloadRecord(frame: RealtimeFrame): Record<string, unknown> | undefined {
  return isRecord(frame.payload) ? frame.payload : undefined;
}

function validateTicketClaims(
  claims: Record<string, unknown>,
  hubId: string,
  routeRoomId: string,
): HubSocketAttachment | undefined {
  const permissions = claims.permissions;
  const permission = claims.permission;
  if (
    claims.hub_id !== hubId
    || typeof claims.room_id !== "string"
    || claims.room_id !== routeRoomId
    || !Number.isSafeInteger(claims.generation)
    || (claims.generation as number) < 1
    || !Number.isSafeInteger(claims.assignment_epoch)
    || (claims.assignment_epoch as number) < 0
    || !Number.isSafeInteger(claims.permission_epoch)
    || (claims.permission_epoch as number) < 0
    || !Number.isSafeInteger(claims.exp)
    || (claims.exp as number) < 0
    || typeof claims.jti !== "string"
    || claims.jti.length < 16
    || claims.jti.length > 256
    || (permission !== "read" && permission !== "edit")
    || !Array.isArray(permissions)
  ) {
    return undefined;
  }
  const normalizedPermissions = permissions.slice();
  if (
    (permission === "read" && (normalizedPermissions.length !== 1 || normalizedPermissions[0] !== "read"))
    || (permission === "edit" && (normalizedPermissions.length !== 2 || normalizedPermissions[0] !== "read" || normalizedPermissions[1] !== "write"))
  ) {
    return undefined;
  }
  return {
    room_id: claims.room_id,
    generation: claims.generation as number,
    assignment_epoch: claims.assignment_epoch as number,
    permission_epoch: claims.permission_epoch as number,
    permission,
    permissions: normalizedPermissions as ("read" | "write")[],
    session_id: "",
    ticket_expires_at: claims.exp as number,
    renewal_counter: 0,
  };
}

function isCiphertextPayload(value: unknown): boolean {
  if (!isRecord(value) || typeof value.ciphertext !== "string") return false;
  try {
    return decodeBase64Url(value.ciphertext).byteLength > 0;
  } catch {
    return false;
  }
}

function savedAckToken(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!isRecord(value)) return undefined;
  for (const name of ["savedAck", "saved_ack", "jws", "token"]) {
    if (typeof value[name] === "string") return value[name] as string;
  }
  return undefined;
}

export class RelayCore {
  private readonly clock: HubClock;

  constructor(
    private readonly config: HubRuntimeConfig,
    private readonly replayStore: ReplayStore,
  ) {
    this.clock = config.clock ?? systemHubClock;
    if (!config.hubId || config.hubId.length > 128) throw new Error("Invalid hub ID");
  }

  /** Processes exactly one frame, enforcing the initial auth frame before relay. */
  async handleFrame(
    sender: HubSocketPeer,
    routeRoomId: string,
    bytes: Uint8Array,
    roomPeers: Iterable<HubSocketPeer>,
  ): Promise<void> {
    if (!sender.isOpen()) return;
    if (bytes.byteLength > MAX_REALTIME_FRAME_BYTES) {
      sender.close(TOO_LARGE_CLOSE_CODE, "frame too large");
      return;
    }
    if (!isOpaqueRoomId(routeRoomId)) {
      sender.close(POLICY_CLOSE_CODE, "invalid room route");
      return;
    }

    let frame: RealtimeFrame;
    try {
      frame = decodeRealtimeFrame(bytes);
    } catch {
      sender.close(POLICY_CLOSE_CODE, "invalid frame");
      return;
    }
    if (frame.opaque_room_id !== routeRoomId) {
      sender.close(POLICY_CLOSE_CODE, "room mismatch");
      return;
    }

    let attachment: HubSocketAttachment | undefined;
    try {
      attachment = getAttachment(sender.getAttachment());
    } catch {
      sender.close(INTERNAL_CLOSE_CODE, "socket state unavailable");
      return;
    }
    if (!attachment) {
      await this.authenticateFirstFrame(sender, frame, routeRoomId);
      return;
    }
    if (attachment.room_id !== routeRoomId) {
      sender.close(POLICY_CLOSE_CODE, "room mismatch");
      return;
    }

    if (frame.message_type !== "ticket-renewal" && attachment.ticket_expires_at <= nowSeconds(this.clock)) {
      sender.close(POLICY_CLOSE_CODE, "ticket expired");
      return;
    }

    if (frame.message_type === "ticket-renewal") {
      await this.renewTicket(sender, frame, attachment);
      return;
    }
    if (frame.message_type === AUTH_MESSAGE) {
      sender.close(POLICY_CLOSE_CODE, "authentication frame already used");
      return;
    }
    if (!ALLOWED_RELAY_TYPES.has(frame.message_type)) {
      sender.close(POLICY_CLOSE_CODE, "unsupported message type");
      return;
    }
    if ((frame.message_type === "y-update" || frame.message_type === "save") && attachment.permission !== "edit") {
      sender.close(POLICY_CLOSE_CODE, "read-only socket");
      return;
    }
    if ((frame.message_type === "y-update" || frame.message_type === "save" || frame.message_type === "presence") && !isCiphertextPayload(frame.payload)) {
      sender.close(POLICY_CLOSE_CODE, "ciphertext required");
      return;
    }
    if (frame.message_type === "saved-ack" && !await this.isValidSavedAck(frame, attachment)) {
      sender.close(POLICY_CLOSE_CODE, "invalid saved acknowledgement");
      return;
    }

    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      sender.close(POLICY_CLOSE_CODE, "invalid frame encoding");
      return;
    }
    for (const peer of roomPeers) {
      if (peer === sender || !peer.isOpen()) continue;
      let recipientAttachment: HubSocketAttachment | undefined;
      try {
        recipientAttachment = getAttachment(peer.getAttachment());
      } catch {
        continue;
      }
      if (recipientAttachment?.room_id === routeRoomId) {
        try {
          peer.send(text);
        } catch {
          peer.close(INTERNAL_CLOSE_CODE, "relay unavailable");
        }
      }
    }
  }

  private async authenticateFirstFrame(
    sender: HubSocketPeer,
    frame: RealtimeFrame,
    routeRoomId: string,
  ): Promise<void> {
    if (frame.message_type !== AUTH_MESSAGE) {
      sender.close(POLICY_CLOSE_CODE, "first frame must authenticate");
      return;
    }
    const payload = payloadRecord(frame);
    if (
      !payload
      || typeof payload.ticket !== "string"
      || typeof payload.session_id !== "string"
      || !VALID_SESSION_ID.test(payload.session_id)
    ) {
      sender.close(POLICY_CLOSE_CODE, "invalid authentication frame");
      return;
    }

    let claims: Record<string, unknown>;
    try {
      claims = await verifyProtocolJws(payload.ticket, {
        tokenType: "ticket",
        pinnedKeys: this.config.pinnedKeys,
        expectedAudience: this.config.hubId,
        nowSeconds: nowSeconds(this.clock),
      });
    } catch {
      sender.close(POLICY_CLOSE_CODE, "invalid ticket");
      return;
    }
    const attachment = validateTicketClaims(claims, this.config.hubId, routeRoomId);
    if (!attachment || attachment.ticket_expires_at <= nowSeconds(this.clock)) {
      sender.close(POLICY_CLOSE_CODE, "ticket claims mismatch");
      return;
    }
    attachment.session_id = payload.session_id;

    let consumed: boolean;
    try {
      consumed = await this.replayStore.consumeJti(
        claims.jti as string,
        claims.exp as number,
        nowSeconds(this.clock),
      );
    } catch {
      sender.close(INTERNAL_CLOSE_CODE, "replay store unavailable");
      return;
    }
    if (!consumed) {
      sender.close(POLICY_CLOSE_CODE, "ticket replay");
      return;
    }

    try {
      sender.setAttachment(attachment);
      sender.send(JSON.stringify({
        v: 2,
        message_type: "hub-ready",
        opaque_room_id: routeRoomId,
      }));
    } catch {
      sender.close(INTERNAL_CLOSE_CODE, "socket state unavailable");
    }
  }

  private async renewTicket(
    sender: HubSocketPeer,
    frame: RealtimeFrame,
    previousAttachment: HubSocketAttachment,
  ): Promise<void> {
    const payload = payloadRecord(frame);
    if (
      !payload
      || typeof payload.ticket !== "string"
      || typeof payload.session_id !== "string"
      || !VALID_SESSION_ID.test(payload.session_id)
      || !Number.isSafeInteger(payload.counter)
    ) {
      sender.close(POLICY_CLOSE_CODE, "invalid renewal frame");
      return;
    }

    let claims: Record<string, unknown>;
    try {
      claims = await verifyProtocolJws(payload.ticket, {
        tokenType: "ticket",
        pinnedKeys: this.config.pinnedKeys,
        expectedAudience: this.config.hubId,
        nowSeconds: nowSeconds(this.clock),
      });
    } catch {
      sender.close(POLICY_CLOSE_CODE, "invalid renewal ticket");
      return;
    }
    const next = validateTicketClaims(claims, this.config.hubId, previousAttachment.room_id);
    if (!next || next.ticket_expires_at <= nowSeconds(this.clock)) {
      sender.close(POLICY_CLOSE_CODE, "renewal claims mismatch");
      return;
    }

    // Re-read attachment after async signature verification so racing renewals
    // cannot both consume the same counter.
    let current: HubSocketAttachment | undefined;
    try {
      current = getAttachment(sender.getAttachment());
    } catch {
      sender.close(INTERNAL_CLOSE_CODE, "socket state unavailable");
      return;
    }
    if (
      !current
      || payload.session_id !== current.session_id
      || payload.counter !== current.renewal_counter + 1
      || next.room_id !== current.room_id
      || next.generation !== current.generation
      || next.assignment_epoch !== current.assignment_epoch
      || next.permission_epoch < current.permission_epoch
    ) {
      sender.close(POLICY_CLOSE_CODE, "renewal state mismatch");
      return;
    }
    next.session_id = current.session_id;
    next.renewal_counter = payload.counter as number;
    try {
      sender.setAttachment(next);
      sender.send(JSON.stringify({
        v: 2,
        message_type: "ticket-renewed",
        opaque_room_id: current.room_id,
        payload: { counter: next.renewal_counter },
      }));
    } catch {
      sender.close(INTERNAL_CLOSE_CODE, "socket state unavailable");
    }
  }

  private async isValidSavedAck(
    frame: RealtimeFrame,
    attachment: HubSocketAttachment,
  ): Promise<boolean> {
    const token = savedAckToken(frame.payload);
    if (!token) return false;
    try {
      const claims = await verifyProtocolJws(token, {
        tokenType: "saved-ack",
        pinnedKeys: this.config.pinnedKeys,
        nowSeconds: nowSeconds(this.clock),
      });
      return claims.room_id === attachment.room_id && claims.generation === attachment.generation;
    } catch {
      return false;
    }
  }
}

export const HUB_CLOSE_CODES = {
  authTimeout: AUTH_TIMEOUT_CLOSE_CODE,
  policy: POLICY_CLOSE_CODE,
  internal: INTERNAL_CLOSE_CODE,
  tooLarge: TOO_LARGE_CLOSE_CODE,
} as const;
