import * as NodeCrypto from "node:crypto";
import * as NodeHttp2 from "node:http2";

export interface ApnsCredentials {
  readonly teamId: string;
  readonly keyId: string;
  readonly privateKeyPem: string;
}

export type ApnsSendResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly status: number; readonly reason: string };

const APNS_HOSTS = {
  production: "https://api.push.apple.com",
  sandbox: "https://api.sandbox.push.apple.com",
} as const;
const APNS_REQUEST_TIMEOUT_MS = 15_000;

const base64Url = (value: string | Uint8Array) => Buffer.from(value).toString("base64url");

/** The provider token APNs accepts for up to an hour; callers reuse one for many pushes. */
export function makeApnsProviderToken(
  credentials: ApnsCredentials,
  issuedAtUnixSeconds: number,
): string {
  const signingInput = `${base64Url(JSON.stringify({ alg: "ES256", kid: credentials.keyId }))}.${base64Url(
    JSON.stringify({ iss: credentials.teamId, iat: issuedAtUnixSeconds }),
  )}`;
  const signature = NodeCrypto.sign("sha256", Buffer.from(signingInput), {
    key: credentials.privateKeyPem,
    dsaEncoding: "ieee-p1363",
  });
  return `${signingInput}.${base64Url(signature)}`;
}

/**
 * Sends one alert notification. APNs only speaks HTTP/2, which `fetch` does not
 * negotiate in Node, so this opens a session for the request and closes it.
 * A rejected device token resolves with `ok: false`; only transport failures reject.
 */
export function sendApnsAlert(input: {
  readonly environment: keyof typeof APNS_HOSTS;
  readonly deviceToken: string;
  readonly topic: string;
  readonly providerToken: string;
  readonly collapseId: string;
  readonly payload: unknown;
}): Promise<ApnsSendResult> {
  return new Promise((resolve, reject) => {
    const session = NodeHttp2.connect(APNS_HOSTS[input.environment]);
    const fail = (cause: unknown) => {
      session.destroy();
      reject(cause instanceof Error ? cause : new Error(String(cause)));
    };
    session.once("error", fail);
    const request = session.request({
      ":method": "POST",
      ":path": `/3/device/${input.deviceToken}`,
      authorization: `bearer ${input.providerToken}`,
      "apns-topic": input.topic,
      "apns-push-type": "alert",
      "apns-priority": "10",
      "apns-collapse-id": input.collapseId.slice(0, 64),
      "content-type": "application/json",
    });
    request.setTimeout(APNS_REQUEST_TIMEOUT_MS, () => fail(new Error("APNs request timed out.")));
    request.once("error", fail);
    let status = 0;
    let body = "";
    request.once("response", (headers) => {
      status = Number(headers[":status"] ?? 0);
    });
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.once("end", () => {
      session.close();
      if (status === 200) return resolve({ ok: true });
      let reason = "unknown";
      try {
        const parsed: unknown = JSON.parse(body);
        if (typeof parsed === "object" && parsed !== null && "reason" in parsed) {
          reason = String(parsed.reason);
        }
      } catch {
        // APNs sends an empty body for some statuses; the status alone is reported.
      }
      resolve({ ok: false, status, reason });
    });
    request.end(JSON.stringify(input.payload));
  });
}

/** APNs reasons that mean the token will never work again and the device should be forgotten. */
export function isDeadApnsToken(result: ApnsSendResult): boolean {
  return (
    !result.ok &&
    (result.status === 410 ||
      result.reason === "BadDeviceToken" ||
      result.reason === "Unregistered" ||
      result.reason === "DeviceTokenNotForTopic")
  );
}
