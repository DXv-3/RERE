# Remote access

Connect a phone, browser, or another desktop app to CodeWrench running on a different
machine. That machine must stay running and reachable while you work.

## CodeWrench Connect

CodeWrench Connect makes an environment available to your other devices without setting
up router forwarding. In the desktop app on the host, open **Settings →
Connections**, sign in, and enable **CodeWrench Connect** for that environment.

For a command-line host, run:

```bash
t3 connect
```

Follow the sign-in instructions. Setup offers a
[background service](./background-service.md); if you decline it, start the
server with `t3 serve`. Saving your sign-in alone does not make the machine
reachable.

On your other device, sign in to the same CodeWrench Connect account and choose the
environment. Over SSH, the CLI prints a browser link and a short code. Open the
link on any device, confirm the code matches, and approve. The CLI continues on
its own, so you do not need to forward an OAuth callback port.

CodeWrench Connect renews access credentials when needed without disconnecting a healthy
connection. Pull request diffs and provider settings keep working after the
previous credential expires. A failed renewal affects that request; it does not
disconnect an otherwise healthy conversation.

## Pair over a LAN or private network

Use direct pairing when the other device can reach the host's network address.

On a desktop host, open **Settings → Connections**, enable **Network access**,
then create a pairing link using an address the other device can reach. Changing
network access restarts the desktop app. You can turn it off in the same place.

For a command-line host, replace `<private-ip>` with the host's LAN or tailnet
address:

```bash
t3 serve --host <private-ip>
```

If a server is already running, generate a fresh link without restarting it:

```bash
t3 pair
```

Scan the QR code on your phone or paste the pairing URL into **Add environment**
in the receiving app. Connection settings are under **Settings → Connections**
on web and desktop and **Settings → Environments** on mobile. A loopback address
such as `127.0.0.1` reaches only the device opening the link.

A device paired this way can run agents and terminals but cannot manage access.
For one of your own devices that should also create and revoke pairing links
and manage the server's skill catalog, mint an administrator link on the host:

```bash
t3 pair --admin
```

Pairing authorizes that device for future connections. Use a fresh one-time link
for each new device; you do not need the original token to reconnect. Links
created in Settings can only be copied from the client that created them while
its Connections page stays open. If you leave or reload that page, create
another link to share.

### Balance new threads across machines

Auto balance is off by default. On web and desktop, enable it in
**Settings → Connections → Load balancing** to automatically choose a machine for
new threads in projects grouped across connected environments. The section
appears once two or more machines are switched on.
Each machine starts at **Normal**. Choose **Prefer** to favor it when it has CPU and
memory available, **Less often** to reduce its share, or **Manual only** to exclude
it from automatic selection. These are preferences, not fixed traffic percentages.
Preferences are saved separately in each client.

The composer checks eligible machines when choosing a draft's environment, then keeps
that choice stable. Choose **Auto balance** again to check current resources, or choose
a specific machine to override it. Choosing a branch or worktree also keeps the draft
on that machine. Existing threads stay where they started. If resource checks are
unavailable or all eligible machines are full, choose a machine manually to continue.
Mobile keeps its manual environment selection.

### Tailscale HTTPS

Join both devices to the same tailnet. In the desktop app, enable **Tailscale
HTTPS** in **Settings → Connections**. Turn it off there to remove that route.

To start a command-line server with Tailscale HTTPS:

```bash
t3 serve --tailscale-serve
```

For an already-running server:

```bash
t3 pair --tailscale
```

The pairing link uses an address such as `https://machine.tailnet.ts.net/`.
The mapping created by `pair --tailscale` persists across restarts. Remove its
default-port mapping with:

```bash
tailscale serve --https=443 off
```

If that port is already in use, choose another with
`--tailscale-serve-port`. See `t3 pair --help` for other pairing options.

### Hosted web app

[app.t3.codes](https://app.t3.codes) needs an HTTPS endpoint. It connects directly
to your server; a hosted pairing link does not make an unreachable backend
reachable or convert HTTP to HTTPS.

For a plain HTTP LAN endpoint, use the direct pairing URL in a browser that can
open it, or pair from the desktop app. On mobile, an IP address entered without a
scheme uses HTTP, so include `https://` when your server uses HTTPS.

## Desktop-managed SSH

In the desktop app, open **Settings → Connections → Add environment**, choose
**SSH**, and enter a host or SSH alias such as `user@example.com`. CodeWrench starts
or reuses a server there and opens the port forward for you. Projects, provider
credentials, and agent work stay on the remote machine.

The remote host must be Linux or an Apple Silicon Mac with `curl` or `wget`,
`tar`, `sha256sum` or `shasum`, and [provider setup](./install.md#providers).
The first launch downloads CodeWrench's server to `~/.t3/runtime` on the host, so
it takes longer than later ones.
Provider CLIs must be on the `PATH` of a non-interactive login shell there;
check with:

```bash
ssh user@example.com 'sh -lc "command -v claude codex"'
```

If SSH reconnecting fails after an app update, retry the launch once. Removing
the connection stops a server that CodeWrench launched; a server that was already
running is left alone.

For Antigravity's Google callback on a remote host, see
[remote sign-in](./providers-antigravity.md#sign-in-from-a-remote-device).

## Manage or revoke access

On the host, **Settings → Connections** lets authorized administrators create
pairing links and revoke client sessions. Revoking an unused link prevents new
pairings; revoke a device's session to remove its existing access. Command-line
management is available through `t3 auth --help`.

A session with an open connection stays listed after its access credential
expires.

To remove an environment from CodeWrench Connect, open your account menu's **CodeWrench Connect**
page, or **Settings → CodeWrench Connect** on mobile, and choose **Deregister**. This
revokes its cloud access and frees its host space even when the environment is
offline or has been wiped. Removing an environment from a device's connection
settings only forgets it on that device; it stays registered to your account.

When idle tunnel cleanup is enabled, CodeWrench Connect removes a linked environment's
tunnel after it stays offline for several minutes. The environment stays linked
and keeps the same address. When the host starts again or wakes, CodeWrench Connect
creates a replacement tunnel on its own. You do not need to pair again. Cleanup
usually runs five to ten minutes after the tunnel goes down.

On a command-line host, `t3 connect unlink` disables exposure while retaining
your login; `t3 connect logout` also clears that login. Background-service
[removal](./background-service.md#manage-the-service) is separate.

### Open it by signing in

An environment linked to your account can let you in with that account instead of a pairing code.
On the host, open **Settings → Connections → Account sign-in** and choose **Allowed** (Sign In
appears beside the pairing code) or **Required** (signing in is the first screen, on the desktop
app too). **Off** is the default. Only the account the environment is linked to gets in; anyone
else is told the machine belongs to someone else. A pairing link still works in every mode, and
**Open On This Computer** on the desktop app's pairing form is the way back in when you cannot
sign in. Choosing a mode does not end sessions that are already open.

Signing out of your account ends the session on this device and forgets every environment you
opened with the account, after asking each one to end that session. Environments you paired with a
code stay.

Treat pairing URLs and authorization codes as passwords. Do not include them in
screenshots, logs, or bug reports.

## Share a model without sharing the environment

Pairing gives someone the whole environment: its threads, files and terminal. To give them only a
model the environment serves, such as a local model behind your own endpoint, create a model share
instead.

**Choose the machine.** The panel shares a model from one machine at a time. When the app is
connected to more than one, such as a laptop and an always-on server, a **Machine** choice appears
at the top, and the share, the list and **Revoke** all follow it. It opens on the only machine with
a public https address if there is exactly one, otherwise on the machine you are using. The line
under it says where people will reach the share. A share code carries that machine's own address,
so a model on your server is shared from the server's address even when you create the share from a
laptop. A machine with no public address shows no code to send, only email invitations. Sharing needs
administrator access on the machine you choose. If the app was paired with a standard link, the
panel says so and you open that machine's own web address in a browser instead.

**Share by email.** Open the environment's web app as an administrator, go to **Settings >
Connections > Shared models**, type the other person's email and choose **Share**. The model
appears in their CodeWrench the next time they are signed in to the account with that email: they
do not paste anything. The share shows as waiting until they have it, then as in their CodeWrench.
This needs this machine to be signed in to your account (see [CodeWrench Connect](#codewrench-connect)
above) and reachable at a secure public address. If it is not signed in, you are told so and nothing
is created.

**Share by code.** Leave the email empty, enter who it is for and choose **Create Share**, or choose
**Copy Share Code Instead** after sharing by email. Send them the text it shows; the token is shown
only once. They open **Settings > Connections > Add a shared model** and paste the code.

If they would rather set it up by hand, they add a Claude provider in **Settings > Providers** on
their own machine with the two environment variables and the custom models from that text. Either
way the model runs here while their threads, files and tools stay on their machine.

Only a Claude provider that points at your own endpoint (`ANTHROPIC_BASE_URL`) can be shared. A
provider signed in to Anthropic cannot. **Revoke** stops a share at once and takes back an email
invitation that has not been collected yet. On the server's command line,
`t3 share-model create <provider> --label <who> [--email <address>] --url <public address>` does
the same, with `list` and `revoke`.

The email must be the one on the other person's CodeWrench account, and the account must have
confirmed it. Someone whose account email is not confirmed is never offered the share, and you can
send a share code instead. Up to 50 email invitations can wait to be accepted at once.

## CodeWrench Connect troubleshooting

Run `t3 connect status` on the host to inspect saved authorization and link
configuration. It is not a live reachability check. If the environment appears
offline, run `t3 service status` and read the displayed log. If it disappears
when SSH closes, see [background-service troubleshooting](./background-service.md#troubleshooting).

| Error                                                     | Recovery                                                                                                                                    |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `environment_link_limit_exceeded` or managed tunnel limit | Deregister an unused environment, then restart CodeWrench on the host.                                                                      |
| `auth_invalid` or `invalid_bearer`                        | Run `t3 connect login`. If credentials were revoked, run `t3 connect logout`, then `t3 connect` again. Restart the server after signing in. |
| Expired or invalid link proof                             | Check the host's date and time, update CodeWrench, then restart it.                                                                         |
| HTTP 403 without a recognized error                       | Check relay access, proxies, and firewall rules. Keep any Cloudflare Ray ID for a bug report.                                               |
| HTTP 408, 429, or 5xx                                     | Check network and relay availability. Startup retries temporary failures for up to ten minutes.                                             |

After fixing a permanent rejection, restart the host's server. On Linux, use
`systemctl --user restart t3code.service` for the background service. For a
foreground server, stop it and run `t3 serve` again with your usual options.
Include the diagnostic message and trace ID when reporting a persistent failure.

For a connection that still fails after linking, check the date and time on both
devices. For server version warnings, follow [Updating CodeWrench](./updating.md).

## Using the Desktop App as a Remote Only

If a computer should only drive work running elsewhere, turn off its local environment. In the
desktop app, open **Settings → Connections** and switch off **Local
environment**. CodeWrench restarts without a local server: no local agents or terminals run, WSL
backends stay off, and other devices can no longer connect to this computer. Your projects,
history, and saved connections are kept, and you keep working through pairing, CodeWrench Connect, or SSH.

Switch **Local environment** back on in the same place to restart with your previous local
settings.
