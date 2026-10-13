import { expect, it } from "vite-plus/test";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { launchCommand, paneEnvironment, paneModels } from "./codePaneLaunch";

const claude = 'claude --settings "$WORKBENCH_CLAUDE_STATUS_SETTINGS"';
const codex =
  "codex -c tui.notifications=true -c 'tui.notification_method=\"osc9\"' -c 'tui.notification_condition=\"always\"'";

it("starts each CLI on its chosen model, set up to report its status", () => {
  expect(launchCommand("claude", "claude-opus-5[1m]")).toBe(
    `${claude} --model 'claude-opus-5[1m]'`,
  );
  expect(launchCommand("codex", "gpt-6-sol")).toBe(`${codex} -m 'gpt-6-sol'`);
  expect(launchCommand("claude")).toBe(claude);
  expect(launchCommand("shell", "anything")).toBeNull();
});

it("never types a model slug that could break out of its quotes", () => {
  expect(launchCommand("claude", "x'; rm -rf ~; '")).toBe(claude);
  expect(launchCommand("codex", "a b")).toBe(codex);
  expect(launchCommand("codex", "$(whoami)")).toBe(codex);
});

it("passes an opening prompt as one quoted word that cannot act as keys or flags", () => {
  expect(launchCommand("claude", undefined, undefined, "Fix Ryan's bug\nthen\u0003stop")).toBe(
    `${claude} 'Fix Ryan'\\''s bug then stop'`,
  );
  expect(launchCommand("codex", "gpt-6-sol", undefined, "--help me")).toBe(
    `${codex} -m 'gpt-6-sol' ' --help me'`,
  );
  expect(launchCommand("claude", undefined, undefined, "  ")).toBe(claude);
});

it("gives a Claude pane the hook settings its launch command reads", () => {
  const settings = JSON.parse(paneEnvironment("claude")!.WORKBENCH_CLAUDE_STATUS_SETTINGS!);
  expect(settings.hooks.Stop[0].hooks[0].command).toContain("printf '\\033]9001;idle\\007'");
  expect(paneEnvironment("shell")).toBeUndefined();
});

it("offers only the CLI's own account's models, not other accounts on the same driver", () => {
  const account = (instanceId: string, slug: string) =>
    ({
      instanceId: ProviderInstanceId.make(instanceId),
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      models: [{ slug, name: slug, isCustom: false, capabilities: null }],
    }) as unknown as ServerProvider;
  expect(
    paneModels([account("codex", "gpt-6-astra"), account("openrouter", "glm-5")], "codex"),
  ).toEqual([{ slug: "gpt-6-astra", name: "gpt-6-astra" }]);
});
