// Fixed Realtime hub v2 protocol vectors. Every key and token here is TEST ONLY;
// none may be reused as a production signing or verification key.
export const TEST_ED25519_KID = "test-ed25519-v1";
export const TEST_ED25519_PUBLIC_KEY_BASE64URL =
  "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo";
export const TEST_SAVED_ACK_ED25519_KID = "test-saved-ack-ed25519-v1";
export const TEST_SAVED_ACK_PUBLIC_KEY_BASE64URL =
  "PUAXw-hDiVqStwqnTRt-vJyYLM8uxJaMwM1V8Sr0Zgw";

export const FRAME_VECTOR = {
  wireText:
    '{"v":2,"message_type":"y-update","opaque_room_id":"room_01","payload":{"ciphertext":"AAECAw","sender_id":"sender-01","session_id":"session-01","counter":7},"slug":"must-be-ignored","role":"admin"}',
  expected: {
    v: 2,
    message_type: "y-update",
    opaque_room_id: "room_01",
    payload: {
      ciphertext: "AAECAw",
      sender_id: "sender-01",
      session_id: "session-01",
      counter: 7,
    },
  },
} as const;

export const BASE64URL_VECTOR = {
  bytes: new Uint8Array([0, 1, 2, 3]),
  encoded: "AAECAw",
  nonCanonical: "AB",
} as const;

export const AAD_VECTOR = {
  label: "syrin:realtime:aad:v1",
  roomId: "room_01",
  generation: 3,
  messageType: "y-update",
  senderId: "sender-01",
  expectedHex:
    "00000015737972696e3a7265616c74696d653a6161643a763100000007726f6f6d5f3031" +
    "00000008000000000000000300000008792d7570646174650000000973656e6465722d3031",
} as const;

export const Y_UPDATE_MAC_VECTOR = {
  label: "syrin:realtime:y-update-mac:v1",
  roomId: "room_01",
  generation: 3,
  messageType: "y-update",
  senderId: "sender-01",
  sessionId: "session-01",
  counter: 7,
  ciphertext: new Uint8Array([0, 1, 2, 3]),
  key: new Uint8Array([
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
    16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31,
  ]),
  expectedTupleHex:
    "0000001e737972696e3a7265616c74696d653a792d7570646174652d6d61633a7631" +
    "00000007726f6f6d5f303100000008000000000000000300000008792d757064617465" +
    "0000000973656e6465722d30310000000a73657373696f6e2d3031000000080000000000000007" +
    "00000020054edec1d0211f624fed0cbca9d4f9400b0e491c43742af2c5b0abebf0c990d8",
  expectedMacBase64Url: "pSbIsE2VTSOEgjsX3H4G57WjbQQ87yw-zwPVi7iqTGc",
} as const;

export const CAS_SAVE_MAC_VECTOR = {
  label: "syrin:realtime:cas-save-mac:v1",
  fieldOrder: ["room", "generation", "expected_revision", "payload_sha256", "permission_epoch", "state_vector_sha256"],
  roomId: "room_01",
  generation: 3,
  expectedRevision: 12,
  payload: new TextEncoder().encode("doc-state"),
  permissionEpoch: 4,
  stateVector: new Uint8Array([1, 2, 0]),
  key: new Uint8Array([
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
    16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31,
  ]),
  expectedTupleHex:
    "0000001e737972696e3a7265616c74696d653a6361732d736176652d6d61633a7631" +
    "00000007726f6f6d5f303100000008000000000000000300000008000000000000000c" +
    "00000020e2bd74d33972e282c2224e0b86fb37bc58037e4332b41cfa112be32521ad9fc4" +
    "00000008000000000000000400000020d7b3d4012540102c40a23acdeee417e06a42a74a5d66c7efe59f4e4aa0537c5c",
  expectedMacBase64Url: "nxcU6H1A6DY_tlldg0Sb7DCl08N3ZhyXcR_GyyzTMz0",
} as const;

export const JWS_VECTOR = {
  nowSeconds: 1_800_000_001,
  audience: "rt2",
  ticket:
    "eyJhbGciOiJFZERTQSIsImtpZCI6InRlc3QtZWQyNTUxOS12MSIsInR5cCI6InN5cmluLXRpY2tldCtqd3QifQ." +
    "eyJwdXJwb3NlIjoic3lyaW46dGlja2V0OnYxIiwiaWF0IjoxODAwMDAwMDAwLCJleHAiOjE4MDAwMDAzMDAsImF1ZCI6InJ0MiJ9." +
    "xFNYccRWByLxAKHo-8AGspbPo8fB1QVRWUpqpnJ5jqlqpde6TFggdN8H082ZxSxDu8qS9EfqiBun-c8wyEB3DQ",
  savedAck:
    "eyJhbGciOiJFZERTQSIsImtpZCI6InRlc3Qtc2F2ZWQtYWNrLWVkMjU1MTktdjEiLCJ0eXAiOiJzeXJpbi1zYXZlZC1hY2srand0In0." +
    "eyJwdXJwb3NlIjoic3lyaW46c2F2ZWQtYWNrOnYxIiwicm9vbV9pZCI6InJvb21fMDEiLCJnZW5lcmF0aW9uIjozLCJyZXZpc2lvbiI6MTIsInN0YXRlX3ZlY3Rvcl9oYXNoIjoiQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQSJ9." +
    "zQX0jH-CNVZcu13y3EpqYpKEWX33bPi-tfMi2pGiFUugjqt9BrMIZ9aMTZ9XHFf_zYvsY_d0VNv5T8ig3J8hAA",
  healthz:
    "eyJhbGciOiJFZERTQSIsImtpZCI6InRlc3QtZWQyNTUxOS12MSIsInR5cCI6InN5cmluLWhlYWx0aHorand0In0." +
    "eyJwdXJwb3NlIjoic3lyaW46aGVhbHRoejp2MSIsImlhdCI6MTgwMDAwMDAwMCwiZXhwIjoxODAwMDAwMDMwLCJhdWQiOiJydDIifQ." +
    "S375iThTrDh5IlPGc_-7MpjkksV8wj-LMJDTgVXFVJsa1hmw2I6cLsM9TG8-rTvWE-bD08fhilz_nRZOIWqUDw",
  boundary: {
    expExactly120SecondsPast:
      "eyJhbGciOiJFZERTQSIsImtpZCI6InRlc3QtZWQyNTUxOS12MSIsInR5cCI6InN5cmluLXRpY2tldCtqd3QifQ." +
      "eyJwdXJwb3NlIjoic3lyaW46dGlja2V0OnYxIiwiaWF0IjoxNzk5OTk5NTgxLCJleHAiOjE3OTk5OTk4ODEsImF1ZCI6InJ0MiJ9." +
      "MzEPUkhJ4GutfVYTPnrCqB220RzMQq3Vu1igFKHYKOpTx5qqQ6wJ8ZT-aJ3k0sbF39cCa8YUD5WKJTGpHHqQAA",
    iatExactly120SecondsFuture:
      "eyJhbGciOiJFZERTQSIsImtpZCI6InRlc3QtZWQyNTUxOS12MSIsInR5cCI6InN5cmluLXRpY2tldCtqd3QifQ." +
      "eyJwdXJwb3NlIjoic3lyaW46dGlja2V0OnYxIiwiaWF0IjoxODAwMDAwMTIxLCJleHAiOjE4MDAwMDA0MjEsImF1ZCI6InJ0MiJ9." +
      "-G7_qNPCaPn9ZDiygIg8eCVEmAXNJNQZMgjVzXrFL1TbUtCUD_bswDI9Fj_bfVT3jf25yRmwrV45KEsIB4jzDw",
  },
  invalid: {
    noneAlgorithm:
      "eyJhbGciOiJub25lIiwia2lkIjoidGVzdC1lZDI1NTE5LXYxIiwidHlwIjoic3lyaW4tdGlja2V0K2p3dCJ9." +
      "eyJwdXJwb3NlIjoic3lyaW46dGlja2V0OnYxIiwiaWF0IjoxODAwMDAwMDAwLCJleHAiOjE4MDAwMDAzMDAsImF1ZCI6InJ0MiJ9." +
      "Zn1vaszd6GLHCycH3XsT2KTnwgxNAjb5j34EefB4AlHWVdbpfvDNNhtwVQXuFdNQL4xy8WYV_DluE2OXHy1zCg",
    forbiddenJku:
      "eyJhbGciOiJFZERTQSIsImtpZCI6InRlc3QtZWQyNTUxOS12MSIsInR5cCI6InN5cmluLXRpY2tldCtqd3QiLCJqa3UiOiJodHRwczovL2V4YW1wbGUuaW52YWxpZC9rZXkifQ." +
      "eyJwdXJwb3NlIjoic3lyaW46dGlja2V0OnYxIiwiaWF0IjoxODAwMDAwMDAwLCJleHAiOjE4MDAwMDAzMDAsImF1ZCI6InJ0MiJ9." +
      "rLwqTAsCIEDj92H5Olhwp79C3Mka9TkaAT1EqdnKZMjFpF8G1ILLAU_CA75mJ7NORslHUdaLHWQIl8OyP0DWCQ",
    untrustedKid:
      "eyJhbGciOiJFZERTQSIsImtpZCI6InVudHJ1c3RlZC10ZXN0LWtleSIsInR5cCI6InN5cmluLXRpY2tldCtqd3QifQ." +
      "eyJwdXJwb3NlIjoic3lyaW46dGlja2V0OnYxIiwiaWF0IjoxODAwMDAwMDAwLCJleHAiOjE4MDAwMDAzMDAsImF1ZCI6InJ0MiJ9." +
      "lleQS5QWTfLnBsf2Abt5tFJ8QR40c9KrO1MIMq0V3UF4pvwqwHk6KsvG5Vk1X_-XZUOPyMd5j7JR4bchM9YyBQ",
    wrongPurpose:
      "eyJhbGciOiJFZERTQSIsImtpZCI6InRlc3QtZWQyNTUxOS12MSIsInR5cCI6InN5cmluLXRpY2tldCtqd3QifQ." +
      "eyJwdXJwb3NlIjoic3lyaW46aGVhbHRoejp2MSIsImlhdCI6MTgwMDAwMDAwMCwiZXhwIjoxODAwMDAwMzAwLCJhdWQiOiJydDIifQ." +
      "qZBaGNNH0JVzlBVQ5K517bUJDQaxNg2yCnIKRZxC30ENWe6T1v7cIgMiWo2iBHOrgwqWVd4GXRhd5r1eu5lRCg",
    wrongTyp:
      "eyJhbGciOiJFZERTQSIsImtpZCI6InRlc3QtZWQyNTUxOS12MSIsInR5cCI6InN5cmluLWhlYWx0aHorand0In0." +
      "eyJwdXJwb3NlIjoic3lyaW46dGlja2V0OnYxIiwiaWF0IjoxODAwMDAwMDAwLCJleHAiOjE4MDAwMDAzMDAsImF1ZCI6InJ0MiJ9." +
      "Sb-O-OnAOf5NJCfCac8om0V-p-G1lr-slkOdGDBQPfiobN5J_QVRDlE6fb0tXVRDDJFQjDNnbPGIkvt1nvaGAA",
    expiredTicket:
      "eyJhbGciOiJFZERTQSIsImtpZCI6InRlc3QtZWQyNTUxOS12MSIsInR5cCI6InN5cmluLXRpY2tldCtqd3QifQ." +
      "eyJwdXJwb3NlIjoic3lyaW46dGlja2V0OnYxIiwiaWF0IjoxNzkwMDAwMDAwLCJleHAiOjE3OTAwMDAzMDAsImF1ZCI6InJ0MiJ9." +
      "XiNAVonxKVIhYX75_8shIBtbFFLFIsJXorFtl0W7skB11oiyyReCkNX_qzfr1ak5R-Hp5NhkP3rnUK3o5vs4Ag",
    longTicket:
      "eyJhbGciOiJFZERTQSIsImtpZCI6InRlc3QtZWQyNTUxOS12MSIsInR5cCI6InN5cmluLXRpY2tldCtqd3QifQ." +
      "eyJwdXJwb3NlIjoic3lyaW46dGlja2V0OnYxIiwiaWF0IjoxODAwMDAwMDAwLCJleHAiOjE4MDAwMDAzMDEsImF1ZCI6InJ0MiJ9." +
      "6qKdMnwHmKt7SnK97dj_XmVjRXdtnnCzrTLnSqxyqWgc6aAp10oVUEw3HKuZxn_qF-c-j6VktIMtFP_bhLN0DQ",
    futureTicket:
      "eyJhbGciOiJFZERTQSIsImtpZCI6InRlc3QtZWQyNTUxOS12MSIsInR5cCI6InN5cmluLXRpY2tldCtqd3QifQ." +
      "eyJwdXJwb3NlIjoic3lyaW46dGlja2V0OnYxIiwiaWF0IjoxODAwMDAwMjAwLCJleHAiOjE4MDAwMDA1MDAsImF1ZCI6InJ0MiJ9." +
      "YjjbuGWIPvOueQpOQdVKdr2HaA7MJk9nZaoH9ycyZxF7IP9rpXSIGNjmL0GzqoW6BbEpjg35-cQMyx8hIibGAw",
    probeTtlOver30Seconds:
      "eyJhbGciOiJFZERTQSIsImtpZCI6InRlc3QtZWQyNTUxOS12MSIsInR5cCI6InN5cmluLWhlYWx0aHorand0In0." +
      "eyJwdXJwb3NlIjoic3lyaW46aGVhbHRoejp2MSIsImlhdCI6MTgwMDAwMDAwMCwiZXhwIjoxODAwMDAwMDMxLCJhdWQiOiJydDIifQ." +
      "MBuCXGJ0lhk7GY0JEO2GZkfutEpYSU06XmwIiXvUGFDtmJXkDL8lClPDajif1VB9BGExBygtCI_bOT4vIrVJBw",
    badSignature:
      "eyJhbGciOiJFZERTQSIsImtpZCI6InRlc3QtZWQyNTUxOS12MSIsInR5cCI6InN5cmluLXRpY2tldCtqd3QifQ." +
      "eyJwdXJwb3NlIjoic3lyaW46dGlja2V0OnYxIiwiaWF0IjoxODAwMDAwMDAwLCJleHAiOjE4MDAwMDAzMDAsImF1ZCI6InJ0MiJ9." +
      "AFNYccRWByLxAKHo-8AGspbPo8fB1QVRWUpqpnJ5jqlqpde6TFggdN8H082ZxSxDu8qS9EfqiBun-c8wyEB3DQ",
  },
} as const;
