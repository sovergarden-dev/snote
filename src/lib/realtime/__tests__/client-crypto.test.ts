import { describe, expect, it } from "vitest";
import {
  decryptRealtimePayload,
  encryptRealtimePayload,
  importRelayDerivationKey,
} from "../client-crypto";

describe("encrypted realtime payloads", () => {
  async function keyFixtures() {
    const raw = crypto.getRandomValues(new Uint8Array(32));
    const relay = await importRelayDerivationKey(raw);
    const mac = await crypto.subtle.importKey(
      "raw",
      raw as BufferSource,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    );
    return { relay, mac };
  }

  it("encrypts and authenticates updates and binds them to generation/session", async () => {
    const { relay, mac } = await keyFixtures();
    const context = {
      roomId: "room_test_01",
      generation: 4,
      messageType: "y-update" as const,
      senderId: "sender-test-01",
      sessionId: "session-test-01",
      counter: 1,
    };
    const plaintext = new TextEncoder().encode("encrypted y-update bytes");
    const payload = await encryptRealtimePayload(plaintext, context, relay, mac);

    expect(payload.mac).toBeTruthy();
    const decoded = await decryptRealtimePayload(payload, {
      roomId: context.roomId,
      generation: context.generation,
      messageType: "y-update",
    }, relay, mac, 0);
    expect(new TextDecoder().decode(decoded.plaintext)).toBe("encrypted y-update bytes");
    await expect(decryptRealtimePayload(payload, {
      roomId: context.roomId,
      generation: context.generation,
      messageType: "y-update",
    }, relay, mac, 1)).rejects.toThrow(/replayed/u);
    await expect(decryptRealtimePayload(payload, {
      roomId: context.roomId,
      generation: context.generation + 1,
      messageType: "y-update",
    }, relay, mac, 0)).rejects.toThrow();
  });

  it("encrypts presence without putting identity or plaintext in the ciphertext envelope", async () => {
    const { relay, mac } = await keyFixtures();
    const context = {
      roomId: "room_test_01",
      generation: 4,
      messageType: "presence" as const,
      senderId: "sender-test-02",
      sessionId: "session-test-02",
      counter: 2,
    };
    const plaintext = new TextEncoder().encode('{"user":{"name":"private-name"}}');
    const payload = await encryptRealtimePayload(plaintext, context, relay, mac);

    expect(payload.ciphertext).not.toContain("private-name");
    expect(payload).not.toHaveProperty("mac");
    const decoded = await decryptRealtimePayload(payload, {
      roomId: context.roomId,
      generation: context.generation,
      messageType: "presence",
    }, relay, mac, 0);
    expect(new TextDecoder().decode(decoded.plaintext)).toBe('{"user":{"name":"private-name"}}');
  });

  it("rejects tampered update ciphertext before Yjs can receive plaintext", async () => {
    const { relay, mac } = await keyFixtures();
    const context = {
      roomId: "room_test_01",
      generation: 4,
      messageType: "y-update" as const,
      senderId: "sender-test-03",
      sessionId: "session-test-03",
      counter: 3,
    };
    const payload = await encryptRealtimePayload(
      new TextEncoder().encode("update"),
      context,
      relay,
      mac,
    );
    const tampered = {
      ...payload,
      ciphertext: `${payload.ciphertext[0] === "A" ? "B" : "A"}${payload.ciphertext.slice(1)}`,
    };

    await expect(decryptRealtimePayload(tampered, {
      roomId: context.roomId,
      generation: context.generation,
      messageType: "y-update",
    }, relay, mac, 0)).rejects.toThrow();
  });
});
