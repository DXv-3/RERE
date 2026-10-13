import type { AuthSessionState, EnvironmentId } from "@t3tools/contracts";
import { AuthAccessReadScope, AuthAccessWriteScope } from "@t3tools/contracts";

import { publicEnvironmentOrigin } from "./modelShareInstructions";

/** One connected environment the Shared models panel can create and revoke shares on. */
export interface ModelShareMachine {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly isPrimary: boolean;
  /** The address a share's holder reaches this machine at, or null when it has none. */
  readonly origin: string | null;
  /** False once this sign-in is known to lack the access scopes; null while not yet known. */
  readonly canManage: boolean | null;
}

/**
 * Hostnames that only resolve on a private network or one machine. `.ts.net` is a tailnet name:
 * it reaches only people on that tailnet unless Funnel is on, which the client cannot tell.
 */
const PRIVATE_HOSTNAME_SUFFIXES = [
  ".localhost",
  ".local",
  ".localdomain",
  ".lan",
  ".home",
  ".internal",
  ".intranet",
  ".corp",
  ".home.arpa",
  ".ts.net",
] as const;

function isPrivateIpv4(octets: ReadonlyArray<number>): boolean {
  const [first = 0, second = 0] = octets;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

function isPrivateIpv6(address: string): boolean {
  const head = address.split(":")[0] ?? "";
  // Unique-local (fc00::/7), link-local (fe80::/10) and loopback or unspecified, plus IPv4-mapped
  // addresses, which are treated as private rather than unpacking the embedded address.
  return (
    address === "::1" ||
    address === "::" ||
    address.startsWith("::ffff:") ||
    /^f[cd][0-9a-f]{2}$/.test(head) ||
    /^fe[89ab][0-9a-f]$/.test(head)
  );
}

/** True for loopback, private-network, link-local and single-label hostnames. */
function isPrivateHostname(rawHostname: string): boolean {
  const hostname = rawHostname.toLowerCase().replace(/\.$/, "");
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    return isPrivateIpv6(hostname.slice(1, -1));
  }
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (ipv4) return isPrivateIpv4(ipv4.slice(1).map(Number));
  if (hostname === "localhost" || !hostname.includes(".")) return true;
  return PRIVATE_HOSTNAME_SUFFIXES.some((suffix) => hostname.endsWith(suffix));
}

/**
 * The origin of an https address other people can reach from the internet. A relay tunnel
 * hostname such as `name.savagesolutions.io` is an ordinary public name and counts.
 */
function publicHttpsOrigin(address: string | null): string | null {
  if (address === null) return null;
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return null;
  }
  return url.protocol === "https:" && !isPrivateHostname(url.hostname) ? url.origin : null;
}

/**
 * The address a share made on one machine is reachable at, for the share code and setup text:
 * the machine's own address when that is public https, else the page's origin when the page was
 * opened at this machine (`page` is null when it was not, as in the desktop app), else none.
 * Without an address there is no code worth handing out.
 */
export function modelShareOrigin(input: {
  readonly httpBaseUrl: string | null;
  readonly page: Pick<Location, "origin" | "hostname"> | null;
}): string | null {
  return (
    publicHttpsOrigin(input.httpBaseUrl) ??
    (input.page === null ? null : publicEnvironmentOrigin(input.page))
  );
}

/**
 * Whether this sign-in can manage sharing on a machine, from the session it holds there. Null
 * until the session is known, so a slow check never blocks trying.
 */
export function canManageModelShares(
  session: Pick<AuthSessionState, "authenticated" | "scopes"> | null,
): boolean | null {
  if (session === null || !session.authenticated || session.scopes === undefined) return null;
  return (
    session.scopes.includes(AuthAccessReadScope) && session.scopes.includes(AuthAccessWriteScope)
  );
}

/**
 * Which machine the panel opens on: the only connected machine with a public https address, else
 * the primary one, so someone with one public server and a laptop shares from the server.
 */
export function defaultModelShareMachineId(
  machines: ReadonlyArray<ModelShareMachine>,
  primaryEnvironmentId: EnvironmentId | null,
): EnvironmentId | null {
  const reachable = machines.filter((machine) => machine.origin?.startsWith("https://") === true);
  if (reachable.length === 1) return reachable[0]!.environmentId;
  const primary = machines.find((machine) => machine.environmentId === primaryEnvironmentId);
  return (primary ?? machines[0])?.environmentId ?? null;
}

/** One plain line under the machine choice saying where shares made there can be reached. */
export function describeModelShareAddress(machine: ModelShareMachine): string {
  return machine.origin === null
    ? "This machine has no public address; only invite-by-email or your own network can use it."
    : `People will reach it at ${machine.origin}`;
}

export function modelShareMachineOptionLabel(machine: ModelShareMachine): string {
  return machine.canManage === false ? `${machine.label} (cannot manage sharing)` : machine.label;
}
