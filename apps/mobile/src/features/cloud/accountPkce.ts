import * as Crypto from "expo-crypto";

function randomHex(byteCount: number): string {
  return Array.from(Crypto.getRandomValues(new Uint8Array(byteCount)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/**
 * A fresh PKCE verifier, its S256 challenge and a state value. Built with expo-crypto because
 * Hermes has no `crypto.subtle`, which the shared `createPkcePair` needs. The verifier is 64 hex
 * characters, inside RFC 7636's 43-128 unreserved-character range.
 */
export async function createAccountAuthRequest(): Promise<{
  readonly verifier: string;
  readonly challenge: string;
  readonly state: string;
}> {
  const verifier = randomHex(32);
  const digest = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, verifier, {
    encoding: Crypto.CryptoEncoding.BASE64,
  });
  const challenge = digest.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return { verifier, challenge, state: randomHex(16) };
}
