import { type EnvironmentId } from "@t3tools/contracts";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import {
  deletePendingAttachmentUpload,
  runAttachmentUploadCycle,
} from "@t3tools/client-runtime/state/attachments";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { attachmentEnvironment } from "../../state/attachments";
import { readPreparedConnection } from "../../state/session";
import { studioUploadKind } from "./studio.logic";

export async function uploadStudioFile(environmentId: EnvironmentId, file: File) {
  const kind = studioUploadKind(file);
  if (!kind || file.size === 0 || file.size > 100 * 1024 * 1024)
    throw new Error("Choose a supported image, video or audio file up to 100 MB.");
  const controller = new AbortController();
  const result = await runAttachmentUploadCycle({
    registry: appAtomRegistry,
    createUploadUrl: attachmentEnvironment.createUploadUrl,
    remove: attachmentEnvironment.remove,
    environmentId,
    upload: {
      type: "file",
      name: file.name,
      mimeType: file.type || "application/octet-stream",
      sizeBytes: file.size,
    },
    resolveUploadUrl: (relativeUrl) => {
      const connection = readPreparedConnection(environmentId);
      return connection ? resolveAssetUrl(connection.httpBaseUrl, relativeUrl) : null;
    },
    transport: (url) => ({
      abort: () => controller.abort(),
      done: fetch(url, {
        method: "POST",
        body: file,
        headers: { "Content-Type": file.type || "application/octet-stream" },
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]),
      }).then((response) => {
        if (!response.ok) throw new Error("Upload rejected. Check the connection and file size.");
      }),
    }),
  });
  if (result.status !== "uploaded") {
    if (result.attachmentId) release(result.attachmentId);
    throw new Error(
      "Upload did not complete. Check the connection and file size, then retry this file.",
    );
  }
  return { attachmentId: result.attachmentId, kind, release: () => release(result.attachmentId) };
  function release(attachmentId: string) {
    deletePendingAttachmentUpload({
      registry: appAtomRegistry,
      remove: attachmentEnvironment.remove,
      environmentId,
      attachmentId,
    });
  }
}
