export interface HostFolderRow {
  readonly name: string;
  /** Absolute path, ready to open the same way a linked file is. */
  readonly path: string;
  readonly kind: "file" | "directory";
}

/**
 * The folder's own children, folders first then files, each with its absolute path. The listing
 * is recursive on the wire; only what sits directly inside the folder is shown.
 */
export function hostFolderRows(
  folderPath: string,
  entries: ReadonlyArray<{ readonly path: string; readonly kind: "file" | "directory" }>,
): HostFolderRow[] {
  const separator = folderPath.includes("\\") && !folderPath.includes("/") ? "\\" : "/";
  const base = folderPath.replace(/[\\/]+$/, "");
  const rows = new Map<string, HostFolderRow>();
  for (const entry of entries) {
    const parts = entry.path.split(/[\\/]+/).filter((part) => part.length > 0);
    const name = parts[0];
    if (name === undefined) continue;
    // A deeper entry still proves its top-level folder exists.
    const kind = parts.length > 1 ? "directory" : entry.kind;
    const known = rows.get(name);
    if (known === undefined || (known.kind === "file" && kind === "directory")) {
      rows.set(name, { name, path: `${base}${separator}${name}`, kind });
    }
  }
  return [...rows.values()].toSorted(
    (a, b) =>
      (a.kind === b.kind ? 0 : a.kind === "directory" ? -1 : 1) || a.name.localeCompare(b.name),
  );
}
