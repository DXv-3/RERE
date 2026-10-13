import type { EnvironmentId } from "@t3tools/contracts";
import { FileIcon, FolderIcon } from "lucide-react";

import { Spinner } from "../ui/spinner";
import { hostFolderRows } from "./hostFolderListing.logic";
import { useProjectEntriesQuery } from "./projectFilesQueryState";

/**
 * What is inside a folder that is not part of the thread's project. A chat link cannot tell a
 * folder from a file, and such a folder has no place in the workspace tree, so its contents are
 * listed here and each one opens the same way a linked file would.
 */
export function HostFolderListing({
  environmentId,
  folderPath,
  onOpenFile,
}: {
  readonly environmentId: EnvironmentId;
  readonly folderPath: string;
  readonly onOpenFile: (path: string) => void;
}) {
  // The folder is listed as its own root: entries come back relative to it.
  const entries = useProjectEntriesQuery(environmentId, folderPath);
  if (entries.data === null) {
    return entries.error ? (
      <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-xs leading-relaxed text-destructive">
        {entries.error}
      </div>
    ) : (
      <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground">
        <Spinner size="lg" />
      </div>
    );
  }
  const rows = hostFolderRows(folderPath, entries.data.entries);
  if (rows.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-xs text-muted-foreground">
        This folder is empty.
      </div>
    );
  }
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-2">
      <p className="px-2 pb-1 text-2xs text-muted-foreground">
        {rows.length === 1 ? "1 item" : `${rows.length} items`}
        {entries.data.truncated ? " (more not shown)" : ""}
      </p>
      <ul>
        {rows.map((row) => (
          <li key={row.path}>
            <button
              type="button"
              onClick={() => onOpenFile(row.path)}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-muted/40 focus-visible:ring-1 focus-visible:ring-primary/25"
            >
              {row.kind === "directory" ? (
                <FolderIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              ) : (
                <FileIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              )}
              <span className="min-w-0 truncate">{row.name}</span>
              <span className="sr-only">{row.kind === "directory" ? ", folder" : ", file"}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
