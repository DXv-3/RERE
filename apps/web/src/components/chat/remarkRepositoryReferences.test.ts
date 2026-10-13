import { describe, expect, it } from "vite-plus/test";

import type { MarkdownNode } from "~/vendor/mdast-find-and-replace";

import { remarkRepositoryReferences } from "./remarkRepositoryReferences";

const repositoryUrl = "https://github.com/acme/web";

const text = (value: string): MarkdownNode => ({ type: "text", value });
const parent = (type: string, ...children: Array<MarkdownNode>): MarkdownNode => ({
  type,
  children,
});

function transform(tree: MarkdownNode, url = repositoryUrl): MarkdownNode {
  remarkRepositoryReferences({ repositoryUrl: url })(tree);
  return tree;
}

/** The tree as a flat string: links as `[label](url)`, everything else by its text. */
function render(node: MarkdownNode): string {
  if (node.type === "link") return `[${node.children?.map(render).join("")}](${node.url})`;
  if (node.children) return node.children.map(render).join("");
  return node.value ?? "";
}

describe("remarkRepositoryReferences", () => {
  it("links a mention in prose and keeps the words around it", () => {
    const tree = transform(parent("root", parent("paragraph", text("Merged #1170, then #1171."))));
    expect(render(tree)).toBe(
      "Merged [#1170](https://github.com/acme/web/issues/1170), then [#1171](https://github.com/acme/web/issues/1171).",
    );
  });

  it("marks each link as a mention and names it for assistive technology", () => {
    const tree = transform(parent("root", parent("paragraph", text("see acme/lib#3 and #4"))));
    const links = tree.children![0]!.children!.filter((node) => node.type === "link");
    expect(links.map((link) => link.data)).toEqual([
      {
        hProperties: {
          dataPullRequestAutolink: "mention",
          ariaLabel: "Pull request or issue 3 in acme/lib on GitHub",
        },
      },
      {
        hProperties: {
          dataPullRequestAutolink: "mention",
          ariaLabel: "Pull request or issue 4 on GitHub",
        },
      },
    ]);
    expect(links.map((link) => link.url)).toEqual([
      "https://github.com/acme/lib/issues/3",
      "https://github.com/acme/web/issues/4",
    ]);
  });

  it("reaches mentions inside bold, lists and headings", () => {
    const tree = transform(
      parent(
        "root",
        parent("heading", text("Fix #5")),
        parent(
          "list",
          parent("listItem", parent("paragraph", parent("strong", text("#1155 (map)")))),
        ),
      ),
    );
    expect(render(tree)).toBe(
      "Fix [#5](https://github.com/acme/web/issues/5)[#1155](https://github.com/acme/web/issues/1155) (map)",
    );
  });

  it("leaves code, existing links, html and definitions alone", () => {
    const tree = transform(
      parent(
        "root",
        { type: "code", value: "git log #12" },
        parent("paragraph", { type: "inlineCode", value: "#13" }),
        parent("paragraph", { type: "link", url: "https://example.com/", children: [text("#14")] }),
        parent("paragraph", parent("linkReference", text("#15"))),
        { type: "html", value: "<b>#16</b>" },
        { type: "definition" },
      ),
    );
    expect(render(tree)).toBe("git log #12#13[#14](https://example.com/)#15<b>#16</b>");
    expect(JSON.stringify(tree)).not.toContain("issues/");
  });

  it("leaves colours, words and other numbers as text", () => {
    const tree = transform(
      parent("root", parent("paragraph", text("color #fff, #1e1e1e, abc#9, 5#6, ##7, #0"))),
    );
    expect(render(tree)).toBe("color #fff, #1e1e1e, abc#9, 5#6, ##7, #0");
  });

  it("does nothing, and allocates nothing, for text without a hash", () => {
    const paragraph = parent("paragraph", text("no mentions here"));
    const first = paragraph.children![0];
    transform(parent("root", paragraph));
    expect(paragraph.children![0]).toBe(first);
  });

  it("makes one pass over a very long message", () => {
    const message = Array.from({ length: 5_000 }, (_, index) => `#${index + 1}`).join(" ");
    const tree = transform(parent("root", parent("paragraph", text(message))));
    const links = tree.children![0]!.children!.filter((node) => node.type === "link");
    expect(links).toHaveLength(5_000);
  });

  it("keeps mentions on the host of the repository it is given", () => {
    const tree = transform(
      parent("root", parent("paragraph", text("#8 and other/repo#9"))),
      "https://github.acme.test/platform/api/",
    );
    expect(render(tree)).toBe(
      "[#8](https://github.acme.test/platform/api/issues/8) and [other/repo#9](https://github.acme.test/other/repo/issues/9)",
    );
  });
});
