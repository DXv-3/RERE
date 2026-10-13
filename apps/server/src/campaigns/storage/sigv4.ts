// @effect-diagnostics nodeBuiltinImport:off - AWS Signature V4 is HMAC-SHA256 over strings; node:crypto is the whole dependency.
import * as NodeCrypto from "node:crypto";

import * as DateTime from "effect/DateTime";

/**
 * AWS Signature Version 4 for a single request, as S3-compatible stores (Amazon S3, Cloudflare R2,
 * MinIO, Backblaze B2) check it. Pure: the same inputs always give the same signature, so it is
 * pinned in tests against the examples AWS publishes.
 */

const sha256Hex = (value: string | Uint8Array) =>
  NodeCrypto.createHash("sha256").update(value).digest("hex");

const hmac = (key: string | Uint8Array, value: string) =>
  NodeCrypto.createHmac("sha256", key).update(value).digest();

/** The payload hash to sign when the body is streamed and cannot be hashed first. HTTPS only. */
export const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";

/** RFC 3986 encoding: only A-Z a-z 0-9 - _ . ~ stay as they are. */
export function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** Encodes each segment of a path and keeps the slashes between them. */
export function encodePath(path: string): string {
  return path.split("/").map(uriEncode).join("/");
}

/** `20130524T000000Z` and `20130524`. */
export function amzDates(atMillis: number): {
  readonly amzDate: string;
  readonly dateStamp: string;
} {
  const amzDate = DateTime.formatIso(DateTime.makeUnsafe(atMillis))
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

export interface SignInput {
  readonly method: string;
  /** Already percent-encoded, exactly as it goes on the wire. */
  readonly canonicalUri: string;
  /** Already encoded `name=value` pairs, sorted by name; empty for none. */
  readonly canonicalQuery?: string;
  /** Every header to sign; names are lower-cased here. Must include `host`. */
  readonly headers: Readonly<Record<string, string>>;
  /** Hex SHA-256 of the body, or UNSIGNED_PAYLOAD. */
  readonly payloadHash: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly region: string;
  readonly service?: string;
  /** Milliseconds since the epoch. */
  readonly at: number;
}

export interface Signed {
  readonly authorization: string;
  readonly signedHeaders: string;
  readonly signature: string;
  readonly amzDate: string;
  /** For tests that pin the intermediate steps. */
  readonly canonicalRequest: string;
  readonly stringToSign: string;
}

export function signRequest(input: SignInput): Signed {
  const service = input.service ?? "s3";
  const { amzDate, dateStamp } = amzDates(input.at);
  const entries = Object.entries(input.headers)
    .map(([name, value]) => [name.toLowerCase(), value.trim().replace(/\s+/g, " ")] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const canonicalHeaders = entries.map(([name, value]) => `${name}:${value}\n`).join("");
  const signedHeaders = entries.map(([name]) => name).join(";");
  const canonicalRequest = [
    input.method,
    input.canonicalUri,
    input.canonicalQuery ?? "",
    canonicalHeaders,
    signedHeaders,
    input.payloadHash,
  ].join("\n");
  const scope = `${dateStamp}/${input.region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${input.secretAccessKey}`, dateStamp), input.region), service),
    "aws4_request",
  );
  const signature = hmac(signingKey, stringToSign).toString("hex");
  return {
    authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope},SignedHeaders=${signedHeaders},Signature=${signature}`,
    signedHeaders,
    signature,
    amzDate,
    canonicalRequest,
    stringToSign,
  };
}

export { sha256Hex };
