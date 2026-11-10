import {
  Agent,
  Environment,
  NativeProvider,
  tool,
  type NativeRealtimeUsage,
  type NativeRealtimeUsageCounters,
} from '@openai/agents';
import {
  Manifest,
  sandboxEnvironment,
  type SandboxClient,
} from '@openai/agents/sandbox';
import * as classic from '@openai/agents/classic';
import * as runtime from '@openai/agents-codex';
import * as facadeTesting from '@openai/agents/testing';
import * as runtimeTesting from '@openai/agents-codex/testing';
import * as facadeDeferred from '@openai/agents/experimental/deferred';
import * as runtimeDeferred from '@openai/agents-codex/experimental/deferred';
import * as facadeTasks from '@openai/agents/experimental/mcp-tasks';
import * as runtimeTasks from '@openai/agents-codex/experimental/mcp-tasks';
import * as facadeA2A from '@openai/agents/a2a';
import * as runtimeA2A from '@openai/agents-codex/a2a';
import * as facadeMemory from '@openai/agents/memory';
import * as runtimeMemory from '@openai/agents-codex/memory';
import * as facadeArtifacts from '@openai/agents/artifacts';
import * as runtimeArtifacts from '@openai/agents-codex/artifacts';
import * as facadeUI from '@openai/agents/ui';
import * as runtimeUI from '@openai/agents-codex/ui';
import * as facadeMcpApps from '@openai/agents/mcp-apps';
import * as runtimeMcpApps from '@openai/agents-codex/mcp-apps';
import {
  ScriptedModel,
  modelResponse,
  assistantMessage,
} from '@openai/agents/classic/testing';
import { z } from 'zod';

// Private fields and unique symbols must retain the same declaration identity.
const runtimeAgent: runtime.Agent<unknown, { count: number }> = new Agent({
  instructions: 'Return a count.',
  outputType: z.strictObject({ count: z.number() }),
});
const facadeAgent: Agent<unknown, { count: number }> = runtimeAgent;
const testing: typeof facadeTesting = runtimeTesting;
const reverseTesting: typeof runtimeTesting = facadeTesting;
const deferred: typeof facadeDeferred = runtimeDeferred;
const reverseDeferred: typeof runtimeDeferred = facadeDeferred;
const tasks: typeof facadeTasks = runtimeTasks;
const reverseTasks: typeof runtimeTasks = facadeTasks;
const a2a: typeof facadeA2A = runtimeA2A;
const reverseA2A: typeof runtimeA2A = facadeA2A;
const memory: typeof facadeMemory = runtimeMemory;
const reverseMemory: typeof runtimeMemory = facadeMemory;
const artifacts: typeof facadeArtifacts = runtimeArtifacts;
const reverseArtifacts: typeof runtimeArtifacts = facadeArtifacts;
const ui: typeof facadeUI = runtimeUI;
const reverseUI: typeof runtimeUI = facadeUI;
const mcpApps: typeof facadeMcpApps = runtimeMcpApps;
const reverseMcpApps: typeof runtimeMcpApps = facadeMcpApps;
void [
  facadeAgent,
  testing,
  reverseTesting,
  deferred,
  reverseDeferred,
  tasks,
  reverseTasks,
  a2a,
  reverseA2A,
  memory,
  reverseMemory,
  artifacts,
  reverseArtifacts,
  ui,
  reverseUI,
  mcpApps,
  reverseMcpApps,
];

const greeting = tool({
  name: 'greeting',
  parameters: z.strictObject({ name: z.string() }),
  execute: ({ name }) => `Hello, ${name.toUpperCase()}!`,
});
const provider = new NativeProvider();
const agent = new Agent<unknown, { count: number }>({
  instructions: 'Return a count.',
  outputType: z.strictObject({ count: z.number() }),
  tools: [greeting],
  provider,
});

async function checkNativeResult() {
  const result = await agent.run('Count the items.');
  const count: number = result.finalOutput.count;
  // @ts-expect-error Structured native output must retain its declared type.
  const wrong: string = result.finalOutput.count;
  return { count, wrong };
}

async function checkSandboxEnvironment(client: SandboxClient) {
  const environment = sandboxEnvironment({
    client,
    manifest: new Manifest({}),
    connect: async () =>
      Environment.lease(
        Environment.local({ cwd: '/workspace', tools: [] }),
        () => {},
      ),
  });
  return agent.session({ environment });
}

function checkNativeRealtimeUsage(usage: NativeRealtimeUsage) {
  const input: NativeRealtimeUsageCounters | undefined =
    usage.input_token_details;
  const audio: number | undefined = input?.audio_tokens;
  const cachedAudio: number | undefined =
    input?.cached_tokens_details?.audio_tokens;
  if (input) {
    // @ts-expect-error A reported usage detail can omit an individual counter.
    const requiredAudio: number = input.audio_tokens;
    void requiredAudio;
  }
  return { audio, cachedAudio };
}

const model = new ScriptedModel([modelResponse([assistantMessage('hello')])]);
const classicAgent = new classic.Agent({ name: 'Classic', model });
const runner = new classic.Runner({ tracingDisabled: true });
const session = new classic.MemorySession({ sessionId: 'types' });
void checkNativeResult;
void checkSandboxEnvironment;
void checkNativeRealtimeUsage;
void runner.run(classicAgent, 'Hello', { session });
