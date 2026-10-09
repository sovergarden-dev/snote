import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  MAX_REALTIME_FRAME_BYTES,
  STALE_PERMISSION_EPOCH_ERROR_CODE,
  StalePermissionEpochError,
  assertCurrentPermissionEpoch,
  buildCasSaveMacInput,
  buildRealtimeAad,
  buildYUpdateMacInput,
  computeHmacSha256,
  decodeBase64Url,
  decodeRealtimeFrame,
  encodeBase64Url,
  encodeCanonicalTuple,
  encodeRealtimeFrame,
  importEd25519VerificationKey,
  importHmacSha256Key,
  verifyHmacSha256,
  verifyProtocolJws,
} from "../protocol";
import { FakeProtocolAdapter } from "./fake-adapter";
import {
  AAD_VECTOR,
  BASE64URL_VECTOR,
  CAS_SAVE_MAC_VECTOR,
  FRAME_VECTOR,
  JWS_VECTOR,
  TEST_ED25519_KID,
  TEST_ED25519_PUBLIC_KEY_BASE64URL,
  TEST_SAVED_ACK_ED25519_KID,
  TEST_SAVED_ACK_PUBLIC_KEY_BASE64URL,
  Y_UPDATE_MAC_VECTOR,
} from "./test-vectors";

const utf8 = new TextEncoder();
const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
const base64url = (bytes: Uint8Array) => encodeBase64Url(bytes);
const rawJson = (value: unknown) => utf8.encode(JSON.stringify(value));

type PinnedKeys = {
  ticketAndProbe: Readonly<Record<string, CryptoKey>>;
  savedAck: Readonly<Record<string, CryptoKey>>;
};

let pinnedKeys: PinnedKeys;

beforeAll(async () => {
  const [edgeKey, savedAckKey] = await Promise.all([
    importEd25519VerificationKey(decodeBase64Url(TEST_ED25519_PUBLIC_KEY_BASE64URL)),
    importEd25519VerificationKey(decodeBase64Url(TEST_SAVED_ACK_PUBLIC_KEY_BASE64URL)),
  ]);
  pinnedKeys = {
    ticketAndProbe: { [TEST_ED25519_KID]: edgeKey },
    savedAck: { [TEST_SAVED_ACK_ED25519_KID]: savedAckKey },
  };
});

describe("Realtime hub v2 shared protocol vectors", () => {
  describe("Ed25519 import capability", () => {
    it("returns a stable code when WebCrypto does not support Ed25519", async () => {
      const unsupported = Object.assign(new Error("unsupported"), {
        name: "NotSupportedError",
      });
      const importKey = vi.spyOn(crypto.subtle, "importKey").mockRejectedValue(unsupported);
      try {
        await expect(importEd25519VerificationKey(new Uint8Array(32))).rejects.toMatchObject({
          code: "ED25519_UNSUPPORTED",
        });
      } finally {
        importKey.mockRestore();
      }
    });

    it("returns the stable unsupported code when WebCrypto is absent", async () => {
      vi.stubGlobal("crypto", { subtle: undefined });
      try {
        await expect(importEd25519VerificationKey(new Uint8Array(32))).rejects.toMatchObject({
          code: "ED25519_UNSUPPORTED",
        });
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });

  describe("strict base64url", () => {
    it("round-trips bytes without padding", () => {
      expect(encodeBase64Url(BASE64URL_VECTOR.bytes)).toBe(BASE64URL_VECTOR.encoded);
      expect(decodeBase64Url(BASE64URL_VECTOR.encoded)).toEqual(BASE64URL_VECTOR.bytes);
      expect(encodeBase64Url(new Uint8Array())).toBe("");
      expect(decodeBase64Url("")).toEqual(new Uint8Array());
    });

    it.each(["AA==", "AA+", "AA/", "A", BASE64URL_VECTOR.nonCanonical, "A A", "é"])(
      "rejects non-canonical or non-base64url input %j",
      (value) => {
        expect(() => decodeBase64Url(value)).toThrow();
      },
    );
  });

  describe("JSON text frame", () => {
    it("decodes the fixed vector, discarding unknown top-level fields", () => {
      const parsed = decodeRealtimeFrame(utf8.encode(FRAME_VECTOR.wireText));
      expect(parsed).toEqual(FRAME_VECTOR.expected);
      expect(parsed).not.toHaveProperty("slug");
      expect(parsed).not.toHaveProperty("role");
    });

    it("encodes the supported envelope deterministically", () => {
      const frame = {
        v: 2,
        message_type: "y-update",
        opaque_room_id: "room_01",
        payload: FRAME_VECTOR.expected.payload,
        role: "must-be-ignored",
      } as typeof FRAME_VECTOR.expected & { role: string };
      const encoded = encodeRealtimeFrame(frame);
      expect(new TextDecoder().decode(encoded)).toBe(
        '{"v":2,"message_type":"y-update","opaque_room_id":"room_01","payload":{"ciphertext":"AAECAw","sender_id":"sender-01","session_id":"session-01","counter":7}}',
      );
      expect(encoded.byteLength).toBeLessThanOrEqual(MAX_REALTIME_FRAME_BYTES);
    });

    it("accepts protocol N and N-1, but rejects missing, unsupported or unsafe versions", () => {
      const envelope = {
        v: 2,
        message_type: "presence",
        opaque_room_id: "room_01",
      };
      expect(decodeRealtimeFrame(rawJson(envelope)).v).toBe(2);
      expect(decodeRealtimeFrame(rawJson({ ...envelope, v: 1 })).v).toBe(1);
      for (const v of [0, 3, Number.MAX_SAFE_INTEGER + 1, 1.5]) {
        expect(() => decodeRealtimeFrame(rawJson({ ...envelope, v }))).toThrow();
      }
      expect(() => decodeRealtimeFrame(rawJson({ ...envelope, v: undefined }))).toThrow();
    });

    it("rejects missing or ill-typed required envelope fields", () => {
      const envelope = {
        v: 2,
        message_type: "presence",
        opaque_room_id: "room_01",
      };
      expect(() => decodeRealtimeFrame(rawJson({ ...envelope, message_type: "" }))).toThrow();
      expect(() => decodeRealtimeFrame(rawJson({ ...envelope, message_type: 1 }))).toThrow();
      expect(() => decodeRealtimeFrame(rawJson({ ...envelope, opaque_room_id: "" }))).toThrow();
      expect(() => decodeRealtimeFrame(rawJson({ ...envelope, opaque_room_id: 9 }))).toThrow();
      expect(() => decodeRealtimeFrame(rawJson({ v: 2, message_type: "presence" }))).toThrow();
    });

    it("rejects malformed UTF-8/JSON, unsafe integers anywhere, and frames over 256 KiB", () => {
      expect(() => decodeRealtimeFrame(new Uint8Array([0xff, 0xfe]))).toThrow();
      expect(() => decodeRealtimeFrame(utf8.encode("{"))).toThrow();
      expect(() =>
        decodeRealtimeFrame(
          rawJson({
            v: 2,
            message_type: "y-update",
            opaque_room_id: "room_01",
            payload: { counter: Number.MAX_SAFE_INTEGER + 1 },
          }),
        ),
      ).toThrow();
      expect(() => decodeRealtimeFrame(new Uint8Array(MAX_REALTIME_FRAME_BYTES + 1))).toThrow();
    });
  });

  describe("versioned length-prefix tuples", () => {
    it("matches the fixed AAD vector byte-for-byte", () => {
      const aad = buildRealtimeAad({
        opaqueRoomId: AAD_VECTOR.roomId,
        generation: AAD_VECTOR.generation,
        messageType: AAD_VECTOR.messageType,
        senderId: AAD_VECTOR.senderId,
      });
      expect(hex(aad)).toBe(AAD_VECTOR.expectedHex);
    });

    it("encodes strings as UTF-8, integers as u64 BE, and each field with u32 BE length", () => {
      expect(hex(encodeCanonicalTuple("ctx:v1", ["é", 7, new Uint8Array([0, 1])]))).toBe(
        "000000066374783a763100000002c3a9000000080000000000000007000000020001",
      );
      for (const invalid of [-1, 1.25, Number.MAX_SAFE_INTEGER + 1, 1n << 53n, 1n << 64n]) {
        expect(() => encodeCanonicalTuple("ctx:v1", [invalid as number | bigint])).toThrow();
      }
    });

    it("matches the fixed y-update MAC input and HMAC-SHA-256 vector", async () => {
      const input = await buildYUpdateMacInput({
        opaqueRoomId: Y_UPDATE_MAC_VECTOR.roomId,
        generation: Y_UPDATE_MAC_VECTOR.generation,
        messageType: Y_UPDATE_MAC_VECTOR.messageType,
        senderId: Y_UPDATE_MAC_VECTOR.senderId,
        sessionId: Y_UPDATE_MAC_VECTOR.sessionId,
        counter: Y_UPDATE_MAC_VECTOR.counter,
        ciphertext: Y_UPDATE_MAC_VECTOR.ciphertext,
      });
      expect(hex(input)).toBe(Y_UPDATE_MAC_VECTOR.expectedTupleHex);
      const key = await importHmacSha256Key(Y_UPDATE_MAC_VECTOR.key);
      const mac = await computeHmacSha256(key, input);
      expect(base64url(mac)).toBe(Y_UPDATE_MAC_VECTOR.expectedMacBase64Url);
      expect(await verifyHmacSha256(key, mac, input)).toBe(true);
      expect(await verifyHmacSha256(key, mac, utf8.encode("different tuple"))).toBe(false);
    });

    it("matches the CAS-save vector at its permission epoch and invalidates the MAC when the epoch changes", async () => {
      expect(CAS_SAVE_MAC_VECTOR.fieldOrder).toEqual([
        "room",
        "generation",
        "expected_revision",
        "payload_sha256",
        "permission_epoch",
        "state_vector_sha256",
      ]);
      const input = await buildCasSaveMacInput({
        opaqueRoomId: CAS_SAVE_MAC_VECTOR.roomId,
        generation: CAS_SAVE_MAC_VECTOR.generation,
        expectedRevision: CAS_SAVE_MAC_VECTOR.expectedRevision,
        payload: CAS_SAVE_MAC_VECTOR.payload,
        permissionEpoch: CAS_SAVE_MAC_VECTOR.permissionEpoch,
        stateVector: CAS_SAVE_MAC_VECTOR.stateVector,
      });
      expect(hex(input)).toBe(CAS_SAVE_MAC_VECTOR.expectedTupleHex);
      const key = await importHmacSha256Key(CAS_SAVE_MAC_VECTOR.key);
      const mac = await computeHmacSha256(key, input);
      expect(base64url(mac)).toBe(CAS_SAVE_MAC_VECTOR.expectedMacBase64Url);
      expect(await verifyHmacSha256(key, mac, input)).toBe(true);

      const changedEpochInput = await buildCasSaveMacInput({
        opaqueRoomId: CAS_SAVE_MAC_VECTOR.roomId,
        generation: CAS_SAVE_MAC_VECTOR.generation,
        expectedRevision: CAS_SAVE_MAC_VECTOR.expectedRevision,
        payload: CAS_SAVE_MAC_VECTOR.payload,
        permissionEpoch: CAS_SAVE_MAC_VECTOR.permissionEpoch + 1,
        stateVector: CAS_SAVE_MAC_VECTOR.stateVector,
      });
      expect(await verifyHmacSha256(key, mac, changedEpochInput)).toBe(false);
      expect(base64url(await computeHmacSha256(key, changedEpochInput))).not.toBe(
        CAS_SAVE_MAC_VECTOR.expectedMacBase64Url,
      );

      const changedStateVectorInput = await buildCasSaveMacInput({
        opaqueRoomId: CAS_SAVE_MAC_VECTOR.roomId,
        generation: CAS_SAVE_MAC_VECTOR.generation,
        expectedRevision: CAS_SAVE_MAC_VECTOR.expectedRevision,
        payload: CAS_SAVE_MAC_VECTOR.payload,
        permissionEpoch: CAS_SAVE_MAC_VECTOR.permissionEpoch,
        stateVector: new Uint8Array([1, 2, 1]),
      });
      expect(await verifyHmacSha256(key, mac, changedStateVectorInput)).toBe(false);
      expect(base64url(await computeHmacSha256(key, changedStateVectorInput))).not.toBe(
        CAS_SAVE_MAC_VECTOR.expectedMacBase64Url,
      );
    });

    it("rejects a stale permission epoch with its stable code and preserves pending outbox", () => {
      const pendingOutbox = new Set(["update-01"]);
      let response: { kind: "saved-ack" } | { kind: "error"; code: string };

      try {
        assertCurrentPermissionEpoch(
          CAS_SAVE_MAC_VECTOR.permissionEpoch,
          CAS_SAVE_MAC_VECTOR.permissionEpoch + 1,
        );
        response = { kind: "saved-ack" };
      } catch (error) {
        expect(error).toBeInstanceOf(StalePermissionEpochError);
        response = {
          kind: "error",
          code:
            error instanceof StalePermissionEpochError
              ? error.code
              : "UNEXPECTED_PROTOCOL_ERROR",
        };
      }

      // The foundation has no runtime save client; model its contract: only a saved-ack clears outbox.
      if (response.kind === "saved-ack") pendingOutbox.clear();
      expect(response).toEqual({
        kind: "error",
        code: STALE_PERMISSION_EPOCH_ERROR_CODE,
      });
      expect([...pendingOutbox]).toEqual(["update-01"]);
    });
  });

  describe("compact Ed25519 JWS verification", () => {
    const options = (tokenType: "ticket" | "saved-ack" | "probe", audience?: string) => ({
      tokenType,
      pinnedKeys,
      nowSeconds: JWS_VECTOR.nowSeconds,
      ...(audience ? { expectedAudience: audience } : {}),
    });

    it("verifies ticket/probe and saved-ack with separate pinned key pairs", async () => {
      const ticket = await verifyProtocolJws(JWS_VECTOR.ticket, options("ticket", JWS_VECTOR.audience));
      expect(ticket).toMatchObject({ purpose: "syrin:ticket:v1", aud: "rt2" });

      const ack = await verifyProtocolJws(JWS_VECTOR.savedAck, options("saved-ack"));
      expect(ack).toMatchObject({
        purpose: "syrin:saved-ack:v1",
        room_id: "room_01",
        generation: 3,
        revision: 12,
      });

      const healthz = await verifyProtocolJws(JWS_VECTOR.healthz, options("probe", JWS_VECTOR.audience));
      expect(healthz).toMatchObject({ purpose: "syrin:healthz:v1", aud: "rt2" });
    });

    it("requires separate key sets for Edge-signed ticket/probe and saved-ack", async () => {
      const sharedKeySet = pinnedKeys.ticketAndProbe;
      await expect(
        verifyProtocolJws(JWS_VECTOR.ticket, {
          ...options("ticket", JWS_VECTOR.audience),
          pinnedKeys: { ticketAndProbe: sharedKeySet, savedAck: sharedKeySet },
        }),
      ).rejects.toThrow("Separate JWS key sets are required");
    });

    it("rejects a kid shared between key sets even when the CryptoKeys differ", async () => {
      const otherKey = await importEd25519VerificationKey(
        decodeBase64Url(TEST_SAVED_ACK_PUBLIC_KEY_BASE64URL),
      );
      await expect(
        verifyProtocolJws(JWS_VECTOR.ticket, {
          ...options("ticket", JWS_VECTOR.audience),
          pinnedKeys: {
            ticketAndProbe: pinnedKeys.ticketAndProbe,
            savedAck: { [TEST_ED25519_KID]: otherKey },
          },
        }),
      ).rejects.toThrow("Separate JWS key sets are required");
    });

    it("accepts both exact ±120-second clock-skew boundaries", async () => {
      await expect(
        verifyProtocolJws(JWS_VECTOR.boundary.expExactly120SecondsPast, options("ticket", JWS_VECTOR.audience)),
      ).resolves.toMatchObject({ purpose: "syrin:ticket:v1" });
      await expect(
        verifyProtocolJws(JWS_VECTOR.boundary.iatExactly120SecondsFuture, options("ticket", JWS_VECTOR.audience)),
      ).resolves.toMatchObject({ purpose: "syrin:ticket:v1" });
    });

    it.each([
      ["alg none", JWS_VECTOR.invalid.noneAlgorithm],
      ["forbidden jku", JWS_VECTOR.invalid.forbiddenJku],
      ["untrusted kid", JWS_VECTOR.invalid.untrustedKid],
      ["wrong purpose", JWS_VECTOR.invalid.wrongPurpose],
      ["wrong typ", JWS_VECTOR.invalid.wrongTyp],
      ["expired ticket", JWS_VECTOR.invalid.expiredTicket],
      ["ticket TTL over 300 seconds", JWS_VECTOR.invalid.longTicket],
      ["iat beyond 120-second skew", JWS_VECTOR.invalid.futureTicket],
      ["invalid signature", JWS_VECTOR.invalid.badSignature],
    ])("rejects %s", async (_case, token) => {
      await expect(
        verifyProtocolJws(token, options("ticket", JWS_VECTOR.audience)),
      ).rejects.toThrow();
    });

    it.each(["crit", "jku", "jwk", "x5u", "x5c", "b64"])(
      "rejects forbidden JWS header %s",
      async (headerName) => {
        const [encodedHeader, encodedPayload, signature] = JWS_VECTOR.ticket.split(".");
        const header = JSON.parse(new TextDecoder().decode(decodeBase64Url(encodedHeader)));
        const value = headerName === "crit" ? ["exp"] : true;
        const changedHeader = encodeBase64Url(
          utf8.encode(JSON.stringify({ ...header, [headerName]: value })),
        );
        const token = `${changedHeader}.${encodedPayload}.${signature}`;
        await expect(
          verifyProtocolJws(token, options("ticket", JWS_VECTOR.audience)),
        ).rejects.toThrow("Forbidden JWS header parameter");
      },
    );

    it("rejects probe TTL over 30 seconds and a mismatched audience", async () => {
      await expect(
        verifyProtocolJws(JWS_VECTOR.invalid.probeTtlOver30Seconds, options("probe", JWS_VECTOR.audience)),
      ).rejects.toThrow();
      await expect(
        verifyProtocolJws(JWS_VECTOR.ticket, options("ticket", "rt1")),
      ).rejects.toThrow();
    });

    it("requires an expected hub audience for tickets and probes", async () => {
      await expect(verifyProtocolJws(JWS_VECTOR.ticket, options("ticket"))).rejects.toThrow();
      await expect(verifyProtocolJws(JWS_VECTOR.healthz, options("probe"))).rejects.toThrow();
    });

    it("rejects malformed compact serialization and non-canonical segments", async () => {
      for (const token of ["one.two", "one.two.three.four", "AAB=.e30.AA", "*.e30.AA"]) {
        await expect(verifyProtocolJws(token, options("ticket", JWS_VECTOR.audience))).rejects.toThrow();
      }
    });

    it("rejects non-string and oversized compact input before parsing", async () => {
      const invalidInputs: unknown[] = [
        null,
        42,
        { compact: JWS_VECTOR.ticket },
        "A".repeat(MAX_REALTIME_FRAME_BYTES + 1),
      ];
      for (const input of invalidInputs) {
        await expect(
          verifyProtocolJws(input as unknown as string, options("ticket", JWS_VECTOR.audience)),
        ).rejects.toThrow("Invalid compact JWS serialization");
      }
    });
  });

  describe("fake adapter shared contract", () => {
    it("uses the same codec and preserves the known payload without trusting unknown metadata", () => {
      const adapter = new FakeProtocolAdapter();
      const received = adapter.receive(utf8.encode(FRAME_VECTOR.wireText));
      expect(received).toEqual(FRAME_VECTOR.expected);
      expect(adapter.send(received)).toEqual(encodeRealtimeFrame(FRAME_VECTOR.expected));
      expect(received).not.toHaveProperty("slug");
      expect(received).not.toHaveProperty("role");
    });

    it("applies the same rejection rules instead of accepting a different adapter dialect", () => {
      const adapter = new FakeProtocolAdapter();
      expect(() =>
        adapter.receive(rawJson({ v: 3, message_type: "presence", opaque_room_id: "room_01" })),
      ).toThrow();
    });
  });
});
