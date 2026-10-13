# T3 Connect setup

Deployment and client configuration for T3 Connect. The [architecture note](../internals/t3-connect.md)
explains the trust boundaries; the [relay README](../../infra/relay/README.md#deployment) owns relay
provisioning instructions.

## Public application configuration

A fresh clone builds against the CodeWrench deployment: the committed `.env.defaults` holds its
public sign-in and relay identifiers. Set `T3CODE_CLOUD=off` to build without account sign-in.

For another deployment, set these values in the repository-root `.env` or `.env.local`:

```dotenv
T3CODE_OIDC_ISSUER=https://login.example.com/realms/example
T3CODE_OIDC_CLIENT_ID=<public client ID for web, desktop and mobile>
T3CODE_OIDC_CLI_CLIENT_ID=<public client ID for the server and CLI>
T3CODE_RELAY_URL=https://relay.example.com
```

Process variables take precedence over `.env.local`, then `.env`. Use these canonical names;
the build loader supplies framework-specific aliases. Every value is a public identifier: all
clients are public OpenID Connect clients and no client secret exists.

Client and bundled-server builds embed the public values, so set them before building.
EAS preview and production environments need the issuer, app client ID, and relay URL.
Bundled servers also accept runtime overrides for operator-managed deployments. The feature stays
hidden unless the issuer, the relevant client ID, and the relay URL are all set.

Copy `infra/relay/.env.example` to `infra/relay/.env` for relay deployment settings.
Deploy `prod` before personal stages because it owns the retained database that their branches
depend on. The stack's `PublishClientConfig` action writes the resulting relay URL back to the root `.env`.

## Identity provider

Accounts live in an OpenID Connect issuer, a Keycloak realm. Create two public clients with the
authorization-code flow and PKCE (S256), and allow the `openid`, `profile`, `email`, and
`offline_access` scopes on both:

- The app client (`T3CODE_OIDC_CLIENT_ID`) serves web, desktop, and mobile. Register the redirect
  URI of each surface: the hosted web origin, the desktop schemes `t3code://app/` and
  `t3code-dev://app/`, and the mobile app's callback scheme.
- The CLI client (`T3CODE_OIDC_CLI_CLIENT_ID`) serves the server and CLI. Allow the loopback
  redirects `http://127.0.0.1/*` and `http://localhost/*`, and enable the **OAuth 2.0 Device
  Authorization Grant**. Headless and SSH authorization use it, and the device endpoint returns an
  error until it is on.

Add the relay audience to both clients' access tokens, for example with a default client scope
holding an audience mapper. Set the same value as `OIDC_AUDIENCE` on the relay
(`codewrench-relay` in the CodeWrench realm) and the issuer URL as `OIDC_ISSUER`. The audience stays
the same across relay stages; the relay URL selects the deployment.

## Opening an environment with an account

An environment can let its owner open a browser by signing in instead of pasting a pairing code. It is off until the owner sets `accountSignIn` to `allowed` or `required` in the server settings, and it only works once the environment is linked to an account. Set `T3CODE_OIDC_ISSUER` and `T3CODE_OIDC_AUDIENCE` (the same audience the relay uses) in the environment's server settings or process environment; with either missing the feature stays unavailable. Only the account the environment is linked to is let in. Sign-up on the issuer may be open, so that check is the whole boundary. The pairing code keeps working in every mode.

The setting lives in **Settings → Connections → Account sign-in** (Off, Allowed, Required); the switch writes the same `accountSignIn` server setting, so editing `settings.json` is equivalent. With `required` the desktop app also asks for a sign-in on first launch instead of bootstrapping itself in silently; its pairing form keeps an "Open On This Computer" recovery. Access tokens are reusable bearer tokens until they expire (the exchange is not a one-time ticket). Signing out of the account calls `POST /api/auth/logout` with each account-opened connection's own bearer token, which ends sessions that account sign-in issued (cookie or bearer) and no others, then forgets those connections locally.

The desktop app and phone connect the same way: Add Environment shows "Connect With My Account" when the host reports account sign-in and the app is signed in. The app sends its account access token to `/oauth/token` as a token exchange (`subject_token_type` `urn:t3:params:oauth:token-type:account-access-token`). The server runs the same owner check as the browser path and issues the same bearer session a pairing exchange does, listed under Connections as "Account sign-in" and revocable there.

## Staying signed in

The account exists so a person's machines can find each other, not to gate access, so nobody should
be asked to sign in twice on the same device. Clients request `offline_access` and renew quietly.
Set the realm's offline session idle time far beyond any gap between uses (the CodeWrench realm
uses five years, with no offline session maximum); Keycloak's default of 30 days signs out a device
left unused for a month. Clients forget a session only when the issuer answers a renewal with
`invalid_grant`.

## Restricting sign-ups

Turn off self-registration in the realm for invitation-only sign-up, or restrict it with the realm's
registration and email-domain settings.

Sign-up restrictions do not revoke an existing account's access. Disable the user in the realm when
its active sessions and future sign-ins must be blocked.

## Approving an account for managed tunnels

Signing up does not grant a managed tunnel. An account can link environments, but the relay
provisions a tunnel only for an account with a row in `relay_managed_tunnel_limits`, keyed by the
user's id in the realm (the token's `sub`). `max_tunnels` is how many it may hold at once.

```sql
INSERT INTO relay_managed_tunnel_limits (user_id, max_tunnels, created_at, updated_at)
VALUES ('<user id>', 3, '<ISO time>', '<ISO time>');
```

Delete the row to stop new tunnels for that account. Tunnels it already holds stay until the
environment is unlinked.
