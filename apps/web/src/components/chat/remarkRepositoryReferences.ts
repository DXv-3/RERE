import {
  findRepositoryReferences,
  repositoryReferenceUrl,
} from "@t3tools/shared/repositoryReferences";

import type { MarkdownNode } from "~/vendor/mdast-find-and-replace";

/** Already a link, or not prose: the parser keeps a mention inside these from being read. */
const SKIPPED_TYPES = new Set([
  "link",
  "linkReference",
  "definition",
  "code",
  "inlineCode",
  "html",
]);

/**
 * Turns `#123` and `owner/repo#123` in a message's prose into links to that issue or pull request.
 *
 * It runs on the tree the parser already made, one pass over its text nodes, so code, existing
 * links, URLs and HTML are never looked at and nothing is parsed twice. A text node without a `#`
 * costs one `includes`. The links are plain anchors the message renderer opens like any other
 * external link; the `mention` marker only tells it not to fetch a preview or add a favicon.
 */
export function remarkRepositoryReferences(options: { readonly repositoryUrl: string }) {
  const { repositoryUrl } = options;
  return (tree: MarkdownNode) => {
    visit(tree);
  };

  function visit(node: MarkdownNode): void {
    const children = node.children;
    if (children === undefined) return;
    for (let index = 0; index < children.length; index += 1) {
      const child = children[index]!;
      if (SKIPPED_TYPES.has(child.type)) continue;
      if (child.type !== "text" || child.value === undefined) {
        visit(child);
        continue;
      }
      const replacement = linkMentions(child.value);
      if (replacement === null) continue;
      children.splice(index, 1, ...replacement);
      index += replacement.length - 1;
    }
  }

  function linkMentions(text: string): Array<MarkdownNode> | null {
    const nodes: Array<MarkdownNode> = [];
    let copied = 0;
    for (const mention of findRepositoryReferences(text)) {
      const url = repositoryReferenceUrl(repositoryUrl, mention);
      if (url === null) continue;
      if (copied < mention.start) {
        nodes.push({ type: "text", value: text.slice(copied, mention.start) });
      }
      nodes.push({
        type: "link",
        url,
        data: {
          hProperties: {
            dataPullRequestAutolink: "mention",
            // GitHub sends the number to whichever of the two it is, and so does this.
            ariaLabel: `Pull request or issue ${mention.number}${
              mention.repository === null ? "" : ` in ${mention.repository}`
            } on GitHub`,
          },
        },
        children: [{ type: "text", value: text.slice(mention.start, mention.end) }],
      });
      copied = mention.end;
    }
    if (nodes.length === 0) return null;
    if (copied < text.length) nodes.push({ type: "text", value: text.slice(copied) });
    return nodes;
  }
}
