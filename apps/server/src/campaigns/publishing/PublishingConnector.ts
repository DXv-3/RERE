import type {
  Campaign,
  CampaignClient,
  CampaignConnectorKind,
  CampaignPlatform,
  CampaignPost,
} from "@t3tools/contracts";
import type * as Effect from "effect/Effect";

/** One post, one platform, and who it is for. */
export interface PublishRequest {
  readonly post: CampaignPost;
  readonly platform: CampaignPlatform;
  readonly client: CampaignClient;
  readonly campaign: Campaign;
}

/**
 * What a connector says happened. A connector never fails the Effect: a refusal, a network error
 * and an error from the service are all outcomes with a reason in words, so the publisher records
 * them the same way.
 */
export interface PublishOutcome {
  readonly success: boolean;
  readonly postId?: string;
  readonly link?: string;
  readonly error?: string;
}

/** The publishing service's own switches. CodeWrench reads them and never changes them. */
export type AutopostState =
  | { readonly kind: "known"; readonly paused: boolean; readonly masterEnabled: boolean }
  | { readonly kind: "unavailable"; readonly reason: string };

export type ConnectorTestResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

export interface PublishingConnector {
  readonly kind: CampaignConnectorKind;
  /** Posts now. */
  readonly publish: (request: PublishRequest) => Effect.Effect<PublishOutcome>;
  /** Hands the service a time to post at, for services that hold the schedule themselves. */
  readonly schedule: (
    request: PublishRequest & { readonly scheduledAt: string },
  ) => Effect.Effect<PublishOutcome>;
  readonly autopostState: (clientId: string) => Effect.Effect<AutopostState>;
  readonly test: () => Effect.Effect<ConnectorTestResult>;
}
