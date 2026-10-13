# T3 Connect Relay

> [!NOTE]
> Sign in to T3 Connect from the app under Settings > Connections.

The relay is the hosted control plane for T3 Connect. It helps clients discover and connect to
remote environments, manages the cloud-side records needed for those connections, and delivers
optional mobile notifications and Live Activities.

The relay is intentionally not in the hot path for normal T3 Code traffic. After a client connects,
regular API and WebSocket traffic goes directly between that client and the selected environment.
See the [T3 Connect architecture note](../../docs/internals/t3-connect.md) for the larger system
design.

## Responsibilities

The relay currently owns:

- Linking T3 Code environments to a cloud account.
- Provisioning and tracking managed environment endpoints.
- Issuing short-lived credentials used to connect clients to linked environments.
- Listing linked environments and registered mobile devices for an account.
- Holding model share invitations: a sharer's machine offers a model to an email address, and the
  signed-in account with that verified email collects it. The share token is encrypted at rest with
  a key the deploy generates (`ModelShareSealingKey`) and is wiped once collected or revoked.
- Registering mobile notification preferences and APNs or FCM tokens.
- Receiving published agent activity and delivering notifications or Live Activity updates.
- Persisting relay state and exposing relay-specific traces for diagnostics.

The environment server and relay have separate credentials and trust boundaries. Read
[Environment Authentication Profile](../../docs/internals/environment-auth.md) before changing token,
credential, or authorization behavior.

## Code Map

- [`alchemy.run.ts`](./alchemy.run.ts) defines the deployed Alchemy stack.
- [`src/worker.ts`](./src/worker.ts) wires Cloudflare bindings, runtime layers, queues, and HTTP APIs.
- [`src/http/Api.ts`](./src/http/Api.ts) contains the relay HTTP handlers and authentication
  boundaries.
- [`src/environments`](./src/environments) contains environment linking, credentials, endpoint
  provisioning, and connection flows.
- [`src/agentActivity`](./src/agentActivity) contains mobile device registration, activity state,
  APNs and FCM delivery, and queue processing.
- [`src/auth`](./src/auth) contains relay token and DPoP proof handling.
- [`src/modelShares`](./src/modelShares) contains model share invites: policy, storage, and the
  token sealing.
- [`src/persistence/schema.ts`](./src/persistence/schema.ts) defines persisted relay state. Keep
  schema and migration changes together.

Shared request and response schemas live in
[`packages/contracts/src/relay.ts`](../../packages/contracts/src/relay.ts). Shared client-side relay
calls live in
[`packages/client-runtime/src/relay/managedRelay.ts`](../../packages/client-runtime/src/relay/managedRelay.ts).

## Working Locally

Install dependencies from the repository root, then run relay-focused checks from this directory:

```sh
vp install
cd infra/relay
vp test run
vp run typecheck
```

To run a smaller test set while iterating:

```sh
vp test run src/environments/EnvironmentLinker.test.ts
```

Before considering a change complete, run the repository-wide checks from the root:

```sh
vp check
vp run typecheck
```

Backend changes should include tests. Prefer testing the real business logic with external
dependencies represented at their boundary rather than mocking internal behavior.

## Deployment

The relay deploys with the Alchemy CLI (`vp run --filter t3code-relay deploy` is `alchemy deploy`
in this directory):

```sh
vp run --filter t3code-relay deploy
```

The stack provisions the Cloudflare Worker and queues, managed endpoint resources, database
connectivity, and, when Axiom is configured, relay tracing resources. Copy [`infra/relay/.env.example`](./.env.example) to
`infra/relay/.env` and fill in the deployment-specific values before deploying. Alchemy loads that
file from the relay directory. Runtime secrets include APNs and optional FCM credentials. Set
`APNS_ENABLED=false` for an Android-only development deployment without Apple credentials. Production adopts
the configured API and tunnel DNS zones as retained Cloudflare resources. Personal stages reference
the production-owned zones.

The relay's database is a Postgres we run ourselves. Hyperdrive reaches it through a Cloudflare
Tunnel hostname that an Access application restricts to one service token; the `RELAY_DB_*` settings
name that hostname, a runtime role, and the token. The database must accept TLS. A deploy does not
apply migrations. Apply them as the database owner, from somewhere the database is reachable, before
the deploy that needs them:

```sh
RELAY_DB_MIGRATION_URL=postgres://owner:...@127.0.0.1:5432/relay vp run --filter t3code-relay migrate
```

The `prod` Alchemy stage is the shared hosted relay for stable and nightly clients and owns the DNS
zones, so deploy it before any other stage. Each stage reads its own `RELAY_DB_*` settings; give a
personal stage its own database.

```sh
vp run --filter t3code-relay deploy -- --stage prod
vp run --filter t3code-relay deploy -- --env-file .env.local
```

The first deploy to a Cloudflare account needs Alchemy's state store:
`alchemy provider cloudflare bootstrap`. The deploying credential must be able to create account API
tokens, because the Worker's DNS and tunnel access are scoped tokens the stack mints.

Emailing the person a model is shared with is optional and off by default. The relay sends one
email per new invite over SMTP only when all five of `MODEL_SHARE_SMTP_HOST`,
`MODEL_SHARE_SMTP_PORT` (must be `465`: implicit TLS, the only port supported),
`MODEL_SHARE_SMTP_USER`, `MODEL_SHARE_SMTP_PASSWORD` (secret) and `MODEL_SHARE_EMAIL_FROM` (for
example `CodeWrench <support@savagesolutions.io>`) are set and non-blank; with any missing, or a
port other than 465, nothing is sent and invites work as before. The connection uses
`cloudflare:sockets` from the Worker.

The email never contains the share token or address, and a failed or slow send (10 seconds) never
fails the invite. It names the sharing account by the verified address the relay learned from that
account's own sign-in token, stored in `relay_account_emails`; an account the relay has not seen yet
gets no email. It greets the recipient by first name when that person already has an account (the
`given_name` claim, kept in the same table), otherwise it says "Hi,". One account can cause at most
20 invite emails a day, one per address. The owner-approved wording is in
[`src/modelShares/modelShareInviteEmail.ts`](./src/modelShares/modelShareInviteEmail.ts); the SMTP
client is [`src/modelShares/smtp.ts`](./src/modelShares/smtp.ts).

Tracing is optional. Without `AXIOM_TOKEN` or `AXIOM_API_KEY` the stack provisions no Axiom
resources, the Worker exports no spans, and no client tracing settings are published.

Alchemy defaults personal deployments to the `dev_$USER` stage. Relay custom domains apply the same
DNS-safe sanitization as Alchemy physical resource names, so `prod` uses
`relay.<RELAY_API_ZONE_NAME>` and `dev_julius` uses
`relay-dev-julius.<RELAY_API_ZONE_NAME>`. Managed environment endpoints are provisioned below
`RELAY_TUNNEL_ZONE_NAME`, which may be a different Cloudflare zone. Production tunnel hostnames use
`prod-<digest>.<RELAY_TUNNEL_ZONE_NAME>`; personal stages use
`<stage>-<digest>.<RELAY_TUNNEL_ZONE_NAME>`. `RELAY_DOMAIN` remains available as an explicit API
domain override.

The stack's `PublishClientConfig` action ([`src/clientConfig.ts`](./src/clientConfig.ts)) writes the
deployed relay URL and tracing configuration into the repository-root `.env`, so subsequent source
builds point at the relay that was just deployed without copying values manually. It runs only when
one of those outputs changed, and `T3CODE_RELAY_CLIENT_CONFIG_ENV` redirects it to another file.

### Deployment CI

The relay is versioned separately from client releases. `.github/workflows/deploy-relay.yml` deploys
the shared Alchemy `prod` stage on every push to `main`. Stable and nightly release builds both
resolve their static public config from the same
`production` GitHub environment. Pull requests do not deploy relay stages. Developers can
deploy personal non-production stages locally with any stage name other than `prod`.

The repository must define these Actions variables shared by relay deployments:

- `CLOUDFLARE_ACCOUNT_ID`
- `AXIOM_ORG_ID` when tracing is enabled

The repository must define these Actions secrets shared by relay deployments:

- `CLOUDFLARE_API_TOKEN`
- `AXIOM_TOKEN` when tracing is enabled

The `production` GitHub environment must define these Actions variables:

- `RELAY_API_ZONE_NAME`
- `RELAY_TUNNEL_ZONE_NAME`
- `RELAY_DOMAIN` if overriding the derived production relay domain
- `OIDC_ISSUER`
- `OIDC_AUDIENCE`
- `RELAY_DB_HOST`
- `RELAY_DB_NAME`
- `RELAY_DB_USER`
- `APNS_ENVIRONMENT`
- `APNS_TEAM_ID`
- `APNS_KEY_ID`
- `APNS_BUNDLE_ID`
- `MODEL_SHARE_SMTP_HOST`, `MODEL_SHARE_SMTP_PORT`, `MODEL_SHARE_SMTP_USER` and
  `MODEL_SHARE_EMAIL_FROM` only to turn on invite emails (see above)

The `production` GitHub environment must define these Actions secrets:

- `RELAY_DB_PASSWORD`
- `RELAY_DB_ACCESS_CLIENT_ID`
- `RELAY_DB_ACCESS_CLIENT_SECRET`
- `APNS_PRIVATE_KEY`
- `FCM_SERVICE_ACCOUNT` when Android push is enabled
- `MODEL_SHARE_SMTP_PASSWORD` only to turn on invite emails (see above)

The account-scoped repository credentials are consumed by Alchemy while provisioning relay stages; they
are not bound into the relay Worker. A deployment with tracing uses an Axiom personal access token,
so `AXIOM_ORG_ID` must accompany `AXIOM_TOKEN`. The release workflow reads the production relay's
derived public URL and `OIDC_ISSUER` from the same environment for downstream desktop, CLI,
and hosted web builds.

See:

- [T3 Connect setup](../../docs/operations/connect-setup.md) for the OpenID Connect issuer, clients, and sign-up restrictions.
- [Relay Observability](../../docs/operations/relay-observability.md) for deployment tracing and diagnostics.
- [T3 Connect architecture](../../docs/internals/t3-connect.md) for environment linking and trust boundaries.
