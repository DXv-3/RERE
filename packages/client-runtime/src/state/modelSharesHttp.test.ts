import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { BearerConnectionTarget, type PreparedConnection } from "../connection/model.ts";
import { remoteHttpClientLayer } from "../rpc/http.ts";
import {
  createEnvironmentModelShare,
  fetchEnvironmentModelShares,
  revokeEnvironmentModelShare,
} from "./modelSharesHttp.ts";

const TARGET = new BearerConnectionTarget({
  environmentId: EnvironmentId.make("environment-server"),
  label: "candid-server",
  connectionId: "bearer:environment-server",
});

const PREPARED: PreparedConnection = {
  environmentId: TARGET.environmentId,
  label: TARGET.label,
  httpBaseUrl: "https://code.example.test/base",
  socketUrl: "wss://code.example.test/ws",
  httpAuthorization: { _tag: "Bearer", token: "server-token" },
  target: TARGET,
};

const SHARE = {
  id: "share-1",
  label: "Sam",
  providerInstanceId: "claudeAgent",
  models: ["qwen"],
  createdAt: "2026-10-09T12:00:00.000Z",
  lastUsedAt: null,
};

type Call = readonly [RequestInfo | URL, RequestInit];

function recordingFetch(respond: () => Response, calls: Array<Call>): typeof fetch {
  return ((request, init) => {
    calls.push([request, init ?? {}]);
    return Promise.resolve(respond());
  }) satisfies typeof fetch;
}

function bodyOf(init: RequestInit): unknown {
  const text =
    typeof init.body === "string"
      ? init.body
      : init.body instanceof Uint8Array
        ? new TextDecoder().decode(init.body)
        : "";
  // The assertion deliberately inspects the serialized wire body.
  return JSON.parse(text);
}

function authorizationOf(init: RequestInit): string | null {
  return new Headers(init.headers).get("authorization");
}

describe("model share requests to a chosen environment", () => {
  it.effect("lists shares from the prepared environment with its own credential", () =>
    Effect.gen(function* () {
      const calls: Array<Call> = [];
      const fetchFn = recordingFetch(
        () => Response.json({ shares: [SHARE], providers: [] }),
        calls,
      );

      const snapshot = yield* fetchEnvironmentModelShares({
        prepared: PREPARED,
        signer: Option.none(),
      }).pipe(Effect.provide(remoteHttpClientLayer(fetchFn)));

      expect(snapshot.shares.map((share) => share.id)).toEqual(["share-1"]);
      expect(calls).toHaveLength(1);
      const [request, init] = calls[0]!;
      expect(String(request)).toBe("https://code.example.test/api/model-shares");
      expect(init.method).toBe("GET");
      expect(authorizationOf(init)).toBe("Bearer server-token");
    }),
  );

  it.effect("creates a share on that environment and returns the one-time token", () =>
    Effect.gen(function* () {
      const calls: Array<Call> = [];
      const fetchFn = recordingFetch(
        () => Response.json({ share: SHARE, token: "secret-token" }),
        calls,
      );

      const created = yield* createEnvironmentModelShare({
        prepared: PREPARED,
        signer: Option.none(),
        share: { label: "Sam", providerInstanceId: "claudeAgent" },
      }).pipe(Effect.provide(remoteHttpClientLayer(fetchFn)));

      expect(created.token).toBe("secret-token");
      const [request, init] = calls[0]!;
      expect(String(request)).toBe("https://code.example.test/api/model-shares");
      expect(init.method).toBe("POST");
      expect(authorizationOf(init)).toBe("Bearer server-token");
      expect(bodyOf(init)).toEqual({ label: "Sam", providerInstanceId: "claudeAgent" });
    }),
  );

  it.effect("revokes a share by id on that environment", () =>
    Effect.gen(function* () {
      const calls: Array<Call> = [];
      const fetchFn = recordingFetch(() => Response.json({ revoked: true }), calls);

      const result = yield* revokeEnvironmentModelShare({
        prepared: PREPARED,
        signer: Option.none(),
        shareId: "share-1",
      }).pipe(Effect.provide(remoteHttpClientLayer(fetchFn)));

      expect(result).toEqual({ revoked: true });
      const [request, init] = calls[0]!;
      expect(String(request)).toBe("https://code.example.test/api/model-shares/revoke");
      expect(bodyOf(init)).toEqual({ id: "share-1" });
    }),
  );

  it.effect("surfaces a missing scope as a typed error the panel can explain", () =>
    Effect.gen(function* () {
      const calls: Array<Call> = [];
      const fetchFn = recordingFetch(
        () =>
          Response.json(
            {
              _tag: "EnvironmentScopeRequiredError",
              code: "insufficient_scope",
              requiredScope: "access:write",
              traceId: "trace-scope",
            },
            { status: 403 },
          ),
        calls,
      );

      const error = yield* createEnvironmentModelShare({
        prepared: PREPARED,
        signer: Option.none(),
        share: { label: "Sam", providerInstanceId: "claudeAgent" },
      }).pipe(Effect.provide(remoteHttpClientLayer(fetchFn)), Effect.flip);

      expect(error).toMatchObject({
        _tag: "EnvironmentScopeRequiredError",
        requiredScope: "access:write",
      });
    }),
  );
});
