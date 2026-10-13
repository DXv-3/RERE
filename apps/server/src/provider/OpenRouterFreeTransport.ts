import * as FreeRequestStore from "./FreeRequestStore.ts";
import * as NodeCrypto from "node:crypto";
// @effect-diagnostics-next-line nodeBuiltinImport:off - session-scoped loopback socket needs Node disconnect/backpressure and closeAllConnections semantics.
import * as NodeHttp from "node:http";
import type { CodexSettings } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

export class FreeTransportError extends Schema.TaggedError<FreeTransportError>()(
  "FreeTransportError",
  {
    reason: Schema.Literals(["not_configured", "invalid_route", "listen_failed"]),
  },
) {}

type Route = NonNullable<CodexSettings["openRouterFree"]>;
type Receipt = FreeRequestStore.FreeReceipt;
export class OpenRouterFreeTransport extends Context.Service<
  OpenRouterFreeTransport,
  {
    readonly open: (
      route: Route,
      owner: { instanceId: string; sessionId: string },
    ) => Effect.Effect<
      {
        readonly args: readonly string[];
        readonly environment: NodeJS.ProcessEnv;
        readonly receipts: () => readonly Receipt[];
      },
      FreeTransportError,
      Scope.Scope
    >;
  }
>()("t3/provider/OpenRouterFreeTransport") {}

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const parse = (text: string): unknown => JSON.parse(text);
const allowedFields = new Set([
  "model",
  "input",
  "instructions",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "stream",
  "max_output_tokens",
  "temperature",
  "top_p",
  "reasoning",
  "text",
  "include",
  "store",
  "prompt_cache_key",
  "metadata",
  "client_metadata",
  "truncation",
]);

// No open-ended body merge: presets, plugins, server tools, fallback models and
// future billable fields must not bypass the zero ceiling. Local tools are fine.
function guard(body: unknown, route: Route): Record<string, unknown> {
  if (!object(body) || body.model !== route.model || !Array.isArray(body.input)) throw Error();
  if (Object.keys(body).some((key) => !allowedFields.has(key))) throw Error();
  const localTool = (tool: unknown, depth = 0): boolean => {
    if (!object(tool) || depth > 4) return false;
    if (["function", "custom"].includes(String(tool.type))) return true;
    return (
      tool.type === "namespace" &&
      Array.isArray(tool.tools) &&
      tool.tools.length <= 128 &&
      tool.tools.every((child) => localTool(child, depth + 1))
    );
  };
  if (
    body.tools !== undefined &&
    (!Array.isArray(body.tools) ||
      body.tools.length > 128 ||
      !body.tools.every((tool) => localTool(tool)))
  )
    throw Error();
  // This first route supports text/local tool results only. Uploaded media can
  // cause independent processing charges and needs a separately qualified path.
  const inspect = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(inspect);
      return;
    }
    if (!object(value)) return;
    if (typeof value.type === "string" && /image|audio|video|file/.test(value.type)) throw Error();
    Object.values(value).forEach(inspect);
  };
  inspect(body.input);
  return {
    ...body,
    store: false,
    provider: {
      only: [route.endpoint],
      allow_fallbacks: false,
      require_parameters: true,
      max_price: { prompt: 0, completion: 0, request: 0 },
    },
  };
}

function completion(value: unknown, route: Route, requestHash: string): Receipt | null {
  if (!object(value)) return null;
  const response = object(value.response) ? value.response : value;
  if (response.status !== "completed") return null;
  const usage = object(response.usage) ? response.usage : null;
  const cost = typeof usage?.cost === "number" && Number.isFinite(usage.cost) ? usage.cost : null;
  const model = typeof response.model === "string" ? response.model : null;
  const responseId =
    typeof response.id === "string" && response.id.length <= 256 ? response.id : null;
  return {
    requestHash,
    model,
    responseId,
    cost,
    httpStatus: 200,
    failure: null,
    state:
      cost === 0 && model === route.model && Boolean(responseId) ? "completed_free" : "uncertain",
  };
}

const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const ledger = yield* FreeRequestStore.FreeRequestStore;
  return OpenRouterFreeTransport.of({
    open: (route, owner) =>
      Effect.gen(function* () {
        if (
          !/^[\w.-]+\/[\w.-]+:free$/.test(route.model) ||
          route.model.length > 256 ||
          !/^[\w.-]+\/[\w./-]+$/.test(route.endpoint) ||
          route.endpoint.length > 256 ||
          [owner.instanceId, owner.sessionId].some((v) => !v || v.length > 256)
        )
          return yield* new FreeTransportError({ reason: "invalid_route" });
        const stored = yield* secrets
          .get("workbench-openrouter-free")
          .pipe(Effect.mapError(() => new FreeTransportError({ reason: "not_configured" })));
        const key = Option.isSome(stored) ? new TextDecoder().decode(stored.value).trim() : "";
        if (!key || key.length > 512 || /\s/.test(key))
          return yield* new FreeTransportError({ reason: "not_configured" });
        // Credential binding only, not a claim about authenticated account identity.
        // Pending/uncertain requests block every model and alias using this key.
        const routeKey = NodeCrypto.createHash("sha256")
          .update("workbench-free-v1\0")
          .update(key)
          .digest("hex");
        const token = NodeCrypto.randomBytes(32).toString("hex");
        const expectedAuth = Buffer.from(`Bearer ${token}`);
        const receipts: Receipt[] = [];
        const active = new Set<Promise<void>>();
        const seen = new Set<string>();
        let busy = false;
        let stopped = false;
        let controller: AbortController | undefined;
        const reject = (res: NodeHttp.ServerResponse, status: number) => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end('{"error":{"message":"Guarded free route unavailable; no fallback was sent."}}');
        };
        const handle = async (req: NodeHttp.IncomingMessage, res: NodeHttp.ServerResponse) => {
          const auth = Buffer.from(req.headers.authorization ?? "");
          if (
            auth.length !== expectedAuth.length ||
            !NodeCrypto.timingSafeEqual(auth, expectedAuth)
          )
            return reject(res, 401);
          if (req.method !== "POST" || req.url !== "/responses") return reject(res, 404);
          if (busy || stopped || seen.size >= 256) return reject(res, 409);
          if (
            req.headers["content-encoding"] ||
            !req.headers["content-type"]?.startsWith("application/json")
          )
            return reject(res, 415);
          busy = true;
          let sent = false;
          let requestHash = "";
          let receipt: Receipt | null = null;
          let requestKey = "";
          let claim: string | null = null;
          let httpStatus: number | null = null;
          let failure: Receipt["failure"] = null;
          let finished = false;
          const tailChunks: Uint8Array[] = [];
          const abort = new AbortController();
          controller = abort;
          const deadline = AbortSignal.timeout(120_000);
          const expire = () => {
            abort.abort();
            req.destroy();
            res.destroy();
          };
          deadline.addEventListener("abort", expire, { once: true });
          res.once("close", () => {
            if (!res.writableFinished) abort.abort();
          });
          try {
            const chunks: Buffer[] = [];
            let bytes = 0;
            for await (const chunk of req) {
              bytes += chunk.length;
              if (bytes > 2_000_000) throw Error();
              chunks.push(Buffer.from(chunk));
            }
            const body = guard(parse(Buffer.concat(chunks).toString("utf8")), route);
            const encoded = JSON.stringify(body);
            requestHash = NodeCrypto.createHash("sha256").update(encoded).digest("hex");
            if (seen.has(requestHash)) return reject(res, 409);
            seen.add(requestHash);
            requestKey = NodeCrypto.createHash("sha256")
              .update(
                JSON.stringify([routeKey, owner.instanceId, owner.sessionId, route, requestHash]),
              )
              .digest("hex");
            claim = await Effect.runPromise(
              ledger
                .begin({
                  requestKey,
                  routeKey,
                  requestHash,
                  instanceId: owner.instanceId,
                  sessionId: owner.sessionId,
                  model: route.model,
                  endpoint: route.endpoint,
                  requestedFields: Object.keys(body),
                })
                .pipe(Effect.timeout("5 seconds")),
            );
            if (!claim) return reject(res, 409);
            sent = true;
            // Fixed origin, no redirects, no automatic retries and no forwarded
            // caller headers. The coding subprocess never receives the API key.
            // @effect-diagnostics-next-line globalFetch:off globalFetchInEffect:off - raw SSE proxy deliberately bypasses shared retry middleware and binds body streaming to the same socket abort signal.
            const upstream = await fetch("https://openrouter.ai/api/v1/responses", {
              method: "POST",
              redirect: "error",
              signal: abort.signal,
              headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
              body: encoded,
            });
            httpStatus = upstream.status;
            if (upstream.status !== 200) {
              failure =
                upstream.status === 429
                  ? "rate_limited"
                  : [401, 403].includes(upstream.status)
                    ? "authentication"
                    : upstream.status === 404
                      ? "no_endpoint"
                      : "upstream_error";
              // Retain a bounded classification, never arbitrary provider text,
              // echoed prompts, upstream headers or credential material.
              if (upstream.body) {
                const reader = upstream.body.getReader();
                try {
                  let text = "";
                  const decoder = new TextDecoder();
                  while (text.length < 8192) {
                    const next = await reader.read();
                    if (next.done) break;
                    text += decoder.decode(next.value, { stream: true });
                  }
                  try {
                    const error = parse(text);
                    if (
                      object(error) &&
                      object(error.error) &&
                      typeof error.error.message === "string" &&
                      /no endpoints.*support.*parameters/i.test(error.error.message)
                    )
                      failure = "unsupported_parameters";
                  } catch {
                    /* Keep the HTTP classification when the body is unavailable. */
                  }
                } finally {
                  await reader.cancel().catch(() => undefined);
                }
              }
              throw Error();
            }
            if (!upstream.body) throw Error();
            const streaming = body.stream === true;
            const contentType = upstream.headers.get("content-type") ?? "";
            if (
              streaming
                ? !contentType.includes("text/event-stream")
                : !contentType.includes("application/json")
            )
              throw Error();
            res.writeHead(200, {
              "content-type": streaming ? "text/event-stream" : "application/json",
            });
            const decoder = new TextDecoder();
            let pending = "";
            let responseBytes = 0;
            for await (const chunk of upstream.body) {
              responseBytes += chunk.length;
              if (responseBytes > 8_000_000) throw Error();
              pending += decoder.decode(chunk, { stream: true });
              if (streaming) {
                let newline: number;
                while ((newline = pending.indexOf("\n")) >= 0) {
                  const line = pending.slice(0, newline).trimEnd();
                  pending = pending.slice(newline + 1);
                  if (line.startsWith("data:") && line.slice(5).trim() !== "[DONE]") {
                    const value = parse(line.slice(5));
                    const found =
                      object(value) && value.type === "response.completed"
                        ? completion(value, route, requestHash)
                        : null;
                    if (found) {
                      if (receipt !== null) throw Error();
                      receipt = found;
                    }
                    if (
                      object(value) &&
                      ["error", "response.failed", "response.incomplete"].includes(
                        String(value.type),
                      )
                    )
                      throw Error();
                  }
                }
                if (pending.length > 1_000_000) throw Error();
              }
              if (!streaming || receipt !== null) {
                tailChunks.push(chunk);
                continue;
              }
              if (!res.write(chunk))
                await new Promise<void>((resolve, rejectWrite) => {
                  const done = () => {
                    res.off("close", closed);
                    resolve();
                  };
                  const closed = () => {
                    res.off("drain", done);
                    rejectWrite(Error());
                  };
                  res.once("drain", done);
                  res.once("close", closed);
                });
            }
            pending += decoder.decode();
            if (!streaming) receipt = completion(parse(pending), route, requestHash);
            if (receipt?.state !== "completed_free") throw Error();
            finished = true;
          } catch {
            if (sent) {
              stopped = true;
              receipt = {
                requestHash,
                model: receipt?.model ?? null,
                responseId: receipt?.responseId ?? null,
                cost: receipt?.cost ?? null,
                state: "uncertain",
                httpStatus,
                failure: failure ?? "transport_or_receipt",
              };
            }
            if (!res.headersSent) reject(res, sent ? 502 : 400);
            else res.destroy();
          } finally {
            deadline.removeEventListener("abort", expire);
            abort.abort();
            controller = undefined;
            if (sent && claim) {
              const outcome: Receipt = receipt ?? {
                requestHash,
                model: null,
                responseId: null,
                cost: null,
                state: "uncertain",
                httpStatus,
                failure: failure ?? "transport_or_receipt",
              };
              receipts.push(outcome);
              try {
                await Effect.runPromise(
                  ledger.settle(requestKey, claim, outcome).pipe(Effect.timeout("5 seconds")),
                );
              } catch {
                stopped = true;
                finished = false;
                res.destroy(); /* The durable dispatched claim remains held. */
              }
            }
            if (finished) {
              for (const chunk of tailChunks) res.write(chunk);
              res.end();
            }
            busy = false;
          }
        };
        const server = NodeHttp.createServer((req, res) => {
          const task = handle(req, res)
            .catch(() => res.destroy())
            .then(() => undefined)
            .finally(() => active.delete(task));
          active.add(task);
        });
        server.requestTimeout = 30_000;
        server.headersTimeout = 10_000;
        server.on("upgrade", (_req, socket) => socket.destroy());
        yield* Effect.acquireRelease(
          Effect.tryPromise({
            try: () =>
              new Promise<void>((resolve, rejectListen) => {
                server.once("error", rejectListen);
                server.listen(0, "127.0.0.1", () => {
                  server.off("error", rejectListen);
                  resolve();
                });
              }),
            catch: () => new FreeTransportError({ reason: "listen_failed" }),
          }),
          () =>
            Effect.promise(async () => {
              stopped = true;
              controller?.abort();
              await new Promise<void>((resolve) => {
                server.close(() => resolve());
                server.closeAllConnections();
              });
              await Promise.allSettled(active);
            }),
        );
        const address = server.address();
        if (!address || typeof address === "string")
          return yield* new FreeTransportError({ reason: "listen_failed" });
        const provider = "workbench_guarded_free";
        const config = {
          model_provider: provider,
          [`model_providers.${provider}`]: {
            name: "Workbench Guarded OpenRouter",
            base_url: `http://127.0.0.1:${address.port}`,
            env_key: "WORKBENCH_FREE_TRANSPORT_TOKEN",
            wire_api: "responses",
            requires_openai_auth: false,
            request_max_retries: 0,
            stream_max_retries: 0,
          },
        };
        return {
          args: Object.entries(config).flatMap(([name, value]) => [
            "-c",
            `${name}=${
              typeof value === "string"
                ? JSON.stringify(value)
                : `{ ${Object.entries(value)
                    .map(([k, v]) => `${k} = ${JSON.stringify(v)}`)
                    .join(", ")} }`
            }`,
          ]),
          environment: { WORKBENCH_FREE_TRANSPORT_TOKEN: token },
          receipts: () => receipts.map((receipt) => ({ ...receipt })),
        };
      }),
  });
});
export const layer = Layer.effect(OpenRouterFreeTransport, make);
