import { afterEach, describe, expect, it, vi } from "vitest";
import { generatePassphrase } from "../crypto";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("generatePassphrase", () => {
  it("keeps the requested length and established alphabet", () => {
    const passphrase = generatePassphrase();

    expect(passphrase).toHaveLength(24);
    expect([...passphrase].every((character) => ALPHABET.includes(character))).toBe(true);
  });

  it("rejects random bytes at or above 220 instead of introducing modulo bias", () => {
    const batches = [[219, 220, 0], [55]];
    let callIndex = 0;
    const getRandomValues = vi.spyOn(crypto, "getRandomValues").mockImplementation((array) => {
      const values = batches[callIndex];
      if (!values) throw new Error("Unexpected random sampling call");
      new Uint8Array(array.buffer, array.byteOffset, array.byteLength).set(values);
      callIndex += 1;
      return array;
    });

    const passphrase = generatePassphrase(3);

    expect(passphrase).toBe(
      `${ALPHABET[219 % ALPHABET.length]}${ALPHABET[0]}${ALPHABET[0]}`,
    );
    expect(getRandomValues).toHaveBeenCalledTimes(2);
  });
});
