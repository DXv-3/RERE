import * as Redacted from "effect/Redacted";

/**
 * Encrypts a model share token for storage. The relay keeps a share token only until the
 * recipient collects it, and never in the clear: a database dump alone cannot be used to reach the
 * sharer's hardware. The AES-GCM key is derived (HKDF) from a relay secret, and each sealed value
 * is bound to its invite and recipient so a value copied onto another row does not open.
 */

const SEAL_VERSION = "v1";
const KEY_INFO = new TextEncoder().encode("t3code-relay/model-share-invite/v1");
const KEY_SALT = new TextEncoder().encode("t3code-relay");
const IV_BYTES = 12;

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function deriveKey(secret: Redacted.Redacted<string>): Promise<CryptoKey> {
  const material = await globalThis.crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(Redacted.value(secret)),
    "HKDF",
    false,
    ["deriveKey"],
  );
  return globalThis.crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: KEY_SALT, info: KEY_INFO },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** `context` is authenticated but not stored; open must be given the same value. */
export async function sealModelShareToken(input: {
  readonly secret: Redacted.Redacted<string>;
  readonly token: string;
  readonly context: string;
}): Promise<string> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const encrypted = await globalThis.crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(input.context) },
    await deriveKey(input.secret),
    new TextEncoder().encode(input.token),
  );
  return `${SEAL_VERSION}.${toBase64Url(iv)}.${toBase64Url(new Uint8Array(encrypted))}`;
}

/** The token, or null when the value is empty, malformed, for another context, or the key differs. */
export async function openModelShareToken(input: {
  readonly secret: Redacted.Redacted<string>;
  readonly sealed: string;
  readonly context: string;
}): Promise<string | null> {
  const [version, iv, encrypted, ...rest] = input.sealed.split(".");
  if (version !== SEAL_VERSION || !iv || !encrypted || rest.length > 0) return null;
  try {
    const decrypted = await globalThis.crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: fromBase64Url(iv),
        additionalData: new TextEncoder().encode(input.context),
      },
      await deriveKey(input.secret),
      fromBase64Url(encrypted),
    );
    return new TextDecoder().decode(decrypted);
  } catch {
    return null;
  }
}
