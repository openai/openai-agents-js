import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import {
  Agent,
  NativeProvider,
  manualTool,
  parseSessionState,
  pendingInput,
  withPendingInput,
} from "../../src";
import { ModelServer, call, message } from "./fixtures/model-server";

const nativeIt = it.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== "1");
afterEach(() => ModelServer.closeAll());
type Row = {
  alias: string;
  input: Record<string, any>[];
  marker: string;
  reject?: boolean;
};
const fn = [
  {
    type: "function_call",
    name: "historical",
    call_id: "historical-fn",
    arguments: '{"note":"staged-function"}',
  },
  {
    type: "function_call_output",
    call_id: "historical-fn",
    output: "staged-function-result",
  },
];
const search = [
  {
    type: "tool_search_call",
    call_id: "historical-search",
    execution: "server",
    arguments: { query: "staged-search" },
    status: "completed",
  },
  {
    type: "tool_search_output",
    call_id: "historical-search",
    execution: "server",
    tools: [],
    status: "completed",
  },
];
const program = [
  {
    type: "program",
    call_id: "historical-program",
    code: "staged-program()",
    fingerprint: "historical-fingerprint",
  },
  {
    type: "program_output",
    call_id: "historical-program",
    result: "staged-program-result",
    status: "completed",
  },
];
const computer = [
  {
    type: "computer_call",
    call_id: "historical-computer",
    action: { type: "click", x: 1, y: 2, button: "left" },
    pending_safety_checks: [],
    status: "completed",
  },
  {
    type: "computer_call_output",
    call_id: "historical-computer",
    output: {
      type: "computer_screenshot",
      image_url: "https://example.invalid/staged-computer.png",
    },
  },
];
const shell = [
  {
    type: "shell_call",
    call_id: "historical-shell",
    action: { commands: ["staged-shell-command"], timeout_ms: 1000 },
    status: "completed",
  },
  {
    type: "shell_call_output",
    call_id: "historical-shell",
    output: [
      {
        stdout: "staged-shell-result",
        stderr: "",
        outcome: { type: "exit", exit_code: 0 },
      },
    ],
  },
];
const patch = [
  {
    type: "apply_patch_call",
    call_id: "historical-patch",
    operation: {
      type: "update_file",
      path: "staged-patch.txt",
      diff: "historical-only",
    },
    status: "completed",
  },
  {
    type: "apply_patch_call_output",
    call_id: "historical-patch",
    output: "staged-patch-result",
    status: "completed",
  },
];
const rows: Row[] = [
  {
    alias: "UserMessageItem",
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "staged-user" }],
      },
    ],
    marker: "staged-user",
  },
  {
    alias: "AssistantMessageItem",
    input: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "staged-assistant" }],
      },
    ],
    marker: "staged-assistant",
  },
  {
    alias: "SystemMessageItem",
    input: [
      {
        type: "message",
        role: "system",
        content: [{ type: "input_text", text: "staged-system" }],
      },
    ],
    marker: "staged-system",
  },
  { alias: "ToolSearchCallItem", input: search, marker: "staged-search" },
  { alias: "ToolSearchOutputItem", input: search, marker: "historical-search" },
  {
    alias: "HostedToolCallItem",
    input: [
      {
        type: "web_search_call",
        status: "completed",
        action: { type: "search", query: "staged-web" },
      },
    ],
    marker: "staged-web",
  },
  { alias: "ProgramCallItem", input: program, marker: "staged-program()" },
  {
    alias: "ProgramCallResultItem",
    input: program,
    marker: "staged-program-result",
  },
  { alias: "FunctionCallItem", input: fn, marker: "staged-function" },
  {
    alias: "ComputerUseCallItem",
    input: computer,
    marker: "staged-computer.png",
  },
  { alias: "ShellCallItem", input: shell, marker: "staged-shell-command" },
  { alias: "ApplyPatchCallItem", input: patch, marker: "staged-patch.txt" },
  {
    alias: "FunctionCallResultItem",
    input: fn,
    marker: "staged-function-result",
  },
  {
    alias: "ComputerCallResultItem",
    input: computer,
    marker: "staged-computer.png",
  },
  { alias: "ShellCallResultItem", input: shell, marker: "staged-shell-result" },
  {
    alias: "ApplyPatchCallResultItem",
    input: patch,
    marker: "staged-patch-result",
  },
  {
    alias: "ReasoningItem",
    input: [
      {
        type: "reasoning",
        summary: [{ type: "summary_text", text: "staged-reasoning" }],
      },
    ],
    marker: "staged-reasoning",
  },
  {
    alias: "CompactionItem",
    input: [
      {
        type: "compaction",
        encrypted_content: "staged-provider-issued-compaction",
      },
    ],
    marker: "staged-provider-issued-compaction",
  },
  {
    alias: "UnknownItem",
    input: [{ type: "provider_extension_future", value: "staged-unknown" }],
    marker: "staged-unknown",
    reject: true,
  },
];

async function capture(server: ModelServer) {
  const config = await server.config();
  const provider = new NativeProvider({
    baseUrl: (config["model_providers.fixture"] as { base_url: string })
      .base_url,
    apiKey: "synthetic-staged-input",
    supportsWebsockets: false,
  });
  const agent = new Agent({
    instructions: "Ask and continue.",
    model: "gpt-5.5",
    provider,
    tools: [
      manualTool({
        name: "decision",
        description: "Decide.",
        parameters: z.object({}),
        result: z.string(),
      }),
    ],
  });
  await using source = await agent.session();
  const turn = await source.submit("initial");
  const ended = turn.wait().catch((error) => error);
  await turn.wait({ until: "manual_tool" });
  const saved = await source.suspend();
  await ended;
  return { provider, agent, saved };
}

for (const row of rows) {
  nativeIt(
    `stages pinned v0 ${row.alias} through its Responses JSON representation`,
    async () => {
      const server = new ModelServer([
        [call("decision", {}, { callId: "current-manual" })],
        ...(row.reject ? [] : [[message("continued")]]),
      ]);
      const { provider, agent, saved } = await capture(server);
      await using _ownedProvider = provider;
      const staged = parseSessionState(
        JSON.stringify(withPendingInput(saved, row.input)),
      );
      expect(pendingInput(staged)).toEqual(row.input);
      if (row.reject) {
        await expect(agent.session({ state: staged })).rejects.toThrow(
          /[Uu]nsupported|unknown/i,
        );
        expect(server.requests).toHaveLength(1);
        return;
      }
      await using restored = await agent.session({ state: staged });
      const request = (await restored.pendingInteractions())[0];
      if (request?.type !== "action_requested")
        throw new Error("Missing current manual grant");
      await restored.respond(request.reply("current accepted result"));
      expect((await restored.restoredTurn!.wait()).finalOutput).toBe(
        "continued",
      );
      expect(server.requests).toHaveLength(2);
      expect(JSON.stringify(server.requests[1].input)).toContain(row.marker);
      server.assertExhausted();
    },
    20000,
  );
}

for (const identity of [
  "historical-shell",
  "current-manual",
  "misleading-call-id",
]) {
  nativeIt(
    `keeps passive legacy local-shell identity: ${identity}`,
    async () => {
      const allowed = identity === "historical-shell";
      const server = new ModelServer([
        [call("decision", {}, { callId: "current-manual" })],
        ...(allowed ? [[message("continued")]] : []),
      ]);
      const { provider, agent, saved } = await capture(server);
      await using _ownedProvider = provider;
      const item = {
        type: "local_shell_call_output",
        id: allowed ? identity : "current-manual",
        output: "historical result",
        ...(identity === "misleading-call-id"
          ? { call_id: "unrelated-ignored-field" }
          : {}),
      };
      const staged = parseSessionState(
        JSON.stringify(withPendingInput(saved, [item])),
      );
      if (!allowed) {
        await expect(agent.session({ state: staged })).rejects.toThrow(
          /cannot reuse a manual call identity/i,
        );
        expect(server.requests).toHaveLength(1);
        return;
      }
      await using restored = await agent.session({ state: staged });
      const request = (await restored.pendingInteractions())[0];
      if (request?.type !== "action_requested")
        throw new Error("Missing current manual grant");
      await restored.respond(request.reply("current accepted result"));
      expect((await restored.restoredTurn!.wait()).finalOutput).toBe(
        "continued",
      );
      expect(server.requests).toHaveLength(2);
      expect(server.requests[1].input).toContainEqual(item);
      server.assertExhausted();
    },
    20000,
  );
}

nativeIt(
  "references one known closed assistant item through the same current provider",
  async () => {
    const closed = message("closed source assistant");
    const server = new ModelServer([
      [closed, call("decision", {}, { callId: "current-manual" })],
      [message("continued")],
    ]);
    const { provider, agent, saved } = await capture(server);
    await using _ownedProvider = provider;
    const reference = { type: "item_reference", id: closed.id as string };
    const staged = parseSessionState(
      JSON.stringify(withPendingInput(saved, [reference])),
    );
    expect(pendingInput(staged)).toEqual([reference]);
    await using restored = await agent.session({ state: staged });
    const request = (await restored.pendingInteractions())[0];
    if (request?.type !== "action_requested")
      throw new Error("Missing current manual grant");
    await restored.respond(request.reply("current accepted result"));
    expect((await restored.restoredTurn!.wait()).finalOutput).toBe("continued");
    expect(server.requests).toHaveLength(2);
    expect(server.requests[1].input).toContainEqual(reference);
    server.assertExhausted();
  },
  20000,
);
