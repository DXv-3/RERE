// @effect-diagnostics anyUnknownInErrorContext:off layerMergeAllWithDependencies:off - Alchemy provider helpers expose framework-owned any requirements.
import * as Alchemy from "alchemy";
import * as Output from "alchemy/Output";
import * as Axiom from "alchemy/Axiom";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Drizzle from "alchemy/Drizzle";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { PublishClientConfig, tokenDigest } from "./src/clientConfig.ts";
import * as RelayDb from "./src/db.ts";
import { axiomConfigured, RelayObservability } from "./src/observability.ts";
import { ManagedEndpointZone, RelayApiZone } from "./src/zone.ts";
import ApiLive, { Api } from "./src/worker.ts";

export default Alchemy.Stack(
  "T3CodeRelay",
  {
    providers: Layer.mergeAll(
      // Alchemy resolves a provider's credentials as soon as it is listed, so
      // a relay deployed without Axiom must not list it at all.
      axiomConfigured
        ? Axiom.providers()
        : (Layer.empty as unknown as ReturnType<typeof Axiom.providers>),
      Cloudflare.providers(),
      Drizzle.providers(),
    ),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const hyperdrive = yield* RelayDb.RelayHyperdrive;
    const managedEndpointZone = yield* ManagedEndpointZone.pipe(Effect.orDie);
    const relayApiZone = yield* RelayApiZone.pipe(Effect.orDie);
    const observability = yield* RelayObservability;
    const api = yield* Api;
    // Without tracing there is nothing but the URL to publish, and that is
    // RELAY_DOMAIN, which the operator already knows.
    if (observability) {
      yield* PublishClientConfig({
        url: api.url,
        mobileTracingUrl: observability.traces.otelTracesEndpoint,
        mobileTracingDataset: observability.traces.name,
        mobileTracingToken: observability.mobileIngestToken.token,
        clientTracingUrl: observability.traces.otelTracesEndpoint,
        clientTracingDataset: observability.traces.name,
        clientTracingToken: observability.clientIngestToken.token,
        tokenDigest: Output.map(
          Output.all(observability.mobileIngestToken.token, observability.clientIngestToken.token),
          tokenDigest,
        ),
      });
    }

    return {
      hyperdriveName: hyperdrive.name,
      workerName: api.workerName,
      url: api.url,
      relayApiZoneId: relayApiZone.zoneId,
      managedEndpointZoneId: managedEndpointZone.zoneId,
      ...(observability
        ? {
            mobileTracingUrl: observability.traces.otelTracesEndpoint,
            mobileTracingDataset: observability.traces.name,
            mobileTracingToken: observability.mobileIngestToken.token,
            clientTracingUrl: observability.traces.otelTracesEndpoint,
            clientTracingDataset: observability.traces.name,
            clientTracingToken: observability.clientIngestToken.token,
          }
        : {}),
    };
  }).pipe(Effect.provide(ApiLive)),
);
