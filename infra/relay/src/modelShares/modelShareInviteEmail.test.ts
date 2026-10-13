import { describe, expect, it } from "@effect/vitest";

import { buildModelShareInviteEmail } from "./modelShareInviteEmail.ts";

const DOWNLOAD_URL = "https://downloads.savagesolutions.io/codewrench/mac/CodeWrench-mac-arm64.zip";

describe("buildModelShareInviteEmail", () => {
  it("uses the approved wording exactly", () => {
    const email = buildModelShareInviteEmail({
      firstName: null,
      sender: "ryan@candidstudios.net",
      machine: "Ryan's MacBook",
      models: ["claude-opus", "gpt-5"],
      recipient: "sam@example.com",
    });
    expect(email.subject).toBe("ryan@candidstudios.net shared an AI model with you on CodeWrench");
    expect(email.text).toBe(
      [
        "Hi,",
        "",
        "ryan@candidstudios.net shared an AI model with you on CodeWrench.",
        "",
        "Shared from: Ryan's MacBook",
        "Models: claude-opus, gpt-5",
        "",
        "To use it, open CodeWrench and sign in with this email address (sam@example.com). The model is added by itself and appears in your model list.",
        "",
        `Do not have CodeWrench yet? Download it for Mac: ${DOWNLOAD_URL}`,
        "",
        "If you were not expecting this, you can ignore this email. Nothing is added unless you sign in.",
      ].join("\n"),
    );
  });

  it("greets by first name when there is one and just says Hi, when there is not", () => {
    const input = {
      sender: "ryan@candidstudios.net",
      machine: "Mac",
      models: ["m"],
      recipient: "sam@example.com",
    };
    const named = buildModelShareInviteEmail({ ...input, firstName: "Samantha" });
    expect(named.text.startsWith("Hi Samantha,\n\nryan@candidstudios.net shared")).toBe(true);
    expect(named.html).toContain(">Hi Samantha,</p>");
    for (const firstName of [null, "", "   "]) {
      const plain = buildModelShareInviteEmail({ ...input, firstName });
      expect(plain.text.startsWith("Hi,\n\n")).toBe(true);
      expect(plain.html).toContain(">Hi,</p>");
    }
    // The name is typed by a person: escaped in the HTML, one line in the text.
    const odd = buildModelShareInviteEmail({ ...input, firstName: "<b>Sam</b>\r\nBcc: x" });
    expect(odd.html).toContain("Hi &lt;b&gt;Sam&lt;/b&gt; Bcc: x,");
    expect(odd.html).not.toContain("<b>");
    expect(odd.text.split("\n")[0]).toBe("Hi <b>Sam</b> Bcc: x,");
  });

  it("escapes every value it puts in the HTML and carries no images or tracking", () => {
    const email = buildModelShareInviteEmail({
      firstName: null,
      sender: "ryan@candidstudios.net",
      machine: `<script>alert("x")</script> & 'co'`,
      models: ["<b>model</b>", "a&b"],
      recipient: `"><img src=x>@example.com`,
    });
    expect(email.html).not.toContain("<script");
    expect(email.html).not.toContain("<b>");
    expect(email.html).not.toContain("<img");
    expect(email.html).toContain(
      "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;co&#39;",
    );
    expect(email.html).toContain("&lt;b&gt;model&lt;/b&gt;, a&amp;b");
    expect(email.html).toContain(
      "sign in with this email address (&quot;&gt;&lt;img src=x&gt;@example.com)",
    );
  });

  it("names the sharer by address and escapes it in the HTML", () => {
    const email = buildModelShareInviteEmail({
      firstName: null,
      sender: "ryan@candidstudios.net",
      machine: "Mac",
      models: ["m"],
      recipient: "sam@example.com",
    });
    expect(email.subject).toBe("ryan@candidstudios.net shared an AI model with you on CodeWrench");
    expect(email.text).toContain(
      "ryan@candidstudios.net shared an AI model with you on CodeWrench.",
    );
    const odd = buildModelShareInviteEmail({
      firstName: null,
      sender: `"<i>x</i>"&@example.com`,
      machine: "Mac",
      models: ["m"],
      recipient: "sam@example.com",
    });
    expect(odd.html).not.toContain("<i>");
    expect(odd.html).toContain("&quot;&lt;i&gt;x&lt;/i&gt;&quot;&amp;@example.com shared");
  });

  it("keeps a typed label on one line and short", () => {
    const email = buildModelShareInviteEmail({
      firstName: null,
      sender: "ryan@candidstudios.net",
      machine: `Line one\r\nBcc: attacker@example.com\n${"x".repeat(500)}`,
      models: ["m"],
      recipient: "sam@example.com",
    });
    const machineLine = email.text.split("\n").find((line) => line.startsWith("Shared from: "));
    expect(machineLine?.length).toBeLessThanOrEqual("Shared from: ".length + 100);
    expect(email.text.split("\n")).toHaveLength(12);
    expect(email.subject).not.toContain("\n");
  });

  it("states only the CodeWrench download address and no share address or token", () => {
    const email = buildModelShareInviteEmail({
      firstName: null,
      sender: "ryan@candidstudios.net",
      machine: "Mac",
      models: ["m"],
      recipient: "sam@example.com",
    });
    const urls = `${email.text} ${email.html}`.match(/https?:\/\/[^\s"<]+/g) ?? [];
    expect(new Set(urls)).toEqual(new Set([DOWNLOAD_URL]));
    expect(email.text).not.toContain("cwm_");
    expect(email.text).not.toContain("model-share");
  });
});
