// Web Crypto helpers for AES-GCM 256 + PBKDF2-SHA256 key derivation.
// Used for end-to-end encrypted notes. Server never sees the passphrase or plaintext.

import { bytesToBase64, base64ToBytes } from "./yjs/base64";

// OWASP 2023 guidance for PBKDF2-SHA256 is 600k iterations. Notes encrypted
// before this bump have `enc_iterations = NULL` in the DB and must keep
// deriving with the legacy count so existing passphrases still work.
export const PBKDF2_ITERATIONS = 600_000;
export const LEGACY_PBKDF2_ITERATIONS = 100_000;
const KEY_LENGTH = 256;
const IV_LENGTH = 12; // bytes for AES-GCM
const SALT_LENGTH = 16;

export type EncBundle = {
  salt: string; // base64
  check: string; // base64 ciphertext of "OK"
};

export function randomSalt(): string {
  const bytes = new Uint8Array(SALT_LENGTH);
  crypto.getRandomValues(bytes);
  return bytesToBase64(bytes);
}

/**
 * Derive an AES-GCM key from a passphrase + salt using PBKDF2-SHA256.
 *
 * Pass the note's `enc_iterations` value from the DB. If the row predates
 * the 600k bump (NULL), pass `LEGACY_PBKDF2_ITERATIONS` (100k) so the
 * derived key matches the one used at encryption time.
 */
export async function deriveKey(
  passphrase: string,
  saltB64: string,
  iterations: number = PBKDF2_ITERATIONS,
): Promise<CryptoKey> {
  const salt = base64ToBytes(saltB64);
  const baseKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    { name: "PBKDF2" },
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: salt as BufferSource,
      iterations,
      hash: "SHA-256",
    },
    baseKey,
    { name: "AES-GCM", length: KEY_LENGTH },
    false,
    ["encrypt", "decrypt"]
  );
}

/**
 * Resolve the correct iteration count for a note row. `NULL` means the
 * note was encrypted before the 600k bump; fall back to the legacy 100k.
 */
export function iterationsFor(dbValue: number | null | undefined): number {
  return dbValue ?? LEGACY_PBKDF2_ITERATIONS;
}

export async function encryptBytes(key: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  const iv = new Uint8Array(IV_LENGTH);
  crypto.getRandomValues(iv);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, data as BufferSource)
  );
  // Pack iv || ciphertext.
  const out = new Uint8Array(iv.byteLength + ct.byteLength);
  out.set(iv, 0);
  out.set(ct, iv.byteLength);
  return out;
}

export async function decryptBytes(key: CryptoKey, packed: Uint8Array): Promise<Uint8Array> {
  if (packed.byteLength <= IV_LENGTH) throw new Error("ciphertext too short");
  const iv = packed.subarray(0, IV_LENGTH);
  const ct = packed.subarray(IV_LENGTH);
  const pt = new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, ct as BufferSource)
  );
  return pt;
}

export async function encryptString(key: CryptoKey, text: string): Promise<string> {
  return bytesToBase64(await encryptBytes(key, new TextEncoder().encode(text)));
}

export async function decryptString(key: CryptoKey, b64: string): Promise<string> {
  return new TextDecoder().decode(await decryptBytes(key, base64ToBytes(b64)));
}

export async function makeCheck(key: CryptoKey): Promise<string> {
  return encryptString(key, "OK");
}

export async function verifyCheck(key: CryptoKey, b64: string): Promise<boolean> {
  try {
    const v = await decryptString(key, b64);
    return v === "OK";
  } catch {
    return false;
  }
}

// Hash helper used for URL-safe key fingerprints (so we never log raw keys).
export async function fingerprint(text: string): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
  );
  return bytesToBase64(bytes).slice(0, 8);
}

// Generate a strong human-friendly passphrase (URL-safe).
export function generatePassphrase(length = 24): string {
  const alphabet =
    "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  const acceptBelow = 256 - (256 % alphabet.length);
  const output = new Uint8Array(length);
  let generated = 0;

  while (generated < output.length) {
    const randomBytes = new Uint8Array(output.length - generated);
    crypto.getRandomValues(randomBytes);

    for (const byte of randomBytes) {
      if (byte >= acceptBelow) continue;
      output[generated++] = alphabet.charCodeAt(byte % alphabet.length);
      if (generated === output.length) break;
    }
  }

  return Array.from(output, (code) => String.fromCharCode(code)).join("");
}
