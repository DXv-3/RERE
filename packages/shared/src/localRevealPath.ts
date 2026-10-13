/**
 * Where a path mentioned in a conversation might live on this computer.
 *
 * A thread can run on another machine, where `~/Documents/x` reads as
 * `/home/agents/Documents/x`. The same folder on this computer sits under this
 * user's home, so a path under any user's home is also tried under the local one.
 */

const POSIX_HOME = /^\/(?:Users|home)\/[^/]+(\/.*)?$/;
const WINDOWS_HOME = /^[A-Za-z]:[\\/]Users[\\/][^\\/]+([\\/].*)?$/;

function joinHome(home: string, rest: string): string {
  const separator = home.includes("\\") && !home.includes("/") ? "\\" : "/";
  const trimmedHome = home.replace(/[\\/]+$/, "");
  const parts = rest.split(/[\\/]+/).filter((part) => part.length > 0);
  return parts.length === 0 ? trimmedHome : [trimmedHome, ...parts].join(separator);
}

function isAbsolute(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);
}

/**
 * Absolute paths to try on this computer, most likely first. Empty when the
 * path is relative, or climbs with `..`, and so names nothing here.
 */
export function localRevealCandidates(rawPath: string, localHome: string): readonly string[] {
  const path = rawPath.trim();
  if (path.length === 0 || path.includes("\0")) return [];
  if (path.split(/[\\/]+/).includes("..")) return [];
  if (path === "~") return [localHome];
  if (path.startsWith("~/") || path.startsWith("~\\")) return [joinHome(localHome, path.slice(2))];
  if (!isAbsolute(path)) return [];

  const candidates = [path];
  const underHome = POSIX_HOME.exec(path) ?? WINDOWS_HOME.exec(path);
  if (underHome) {
    const mapped = joinHome(localHome, underHome[1] ?? "");
    if (mapped !== path) candidates.push(mapped);
  }
  return candidates;
}
