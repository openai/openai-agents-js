import { afterEach, expect, it, vi } from 'vitest';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Codex, type CodexOptions } from '@openai/codex-sdk';
import {
  invokeFunctionTool,
  registerToolSessionOwner,
  type ToolCallContext,
} from '../../src/runtime/tools';
import { nativeCodexTool } from '../../../agents-extensions/src/experimental/codex';

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

it
  .skipIf(process.platform === 'win32')
  .each(['default', 'empty', 'explicit', 'inherited', 'provided'])(
  'isolates the native CLI environment with %s configuration',
  async (configuration) => {
    const root = await mkdtemp(join(tmpdir(), 'native-codex-environment-'));
    roots.push(root);
    const selected = {
      SDK_UNRELATED_TOKEN: 'synthetic-unrelated-token',
      CODEX_API_KEY: 'synthetic-codex-key',
      HOME: root,
      HTTPS_PROXY: 'http://127.0.0.1:9',
      PYTHONPATH: '/synthetic-module-search-path',
    };
    for (const [name, value] of Object.entries(selected))
      vi.stubEnv(name, value);
    const cli = join(root, 'codex');
    await writeFile(
      cli,
      `#!${process.execPath}\n` +
        `const observed = Object.fromEntries(${JSON.stringify(Object.keys(selected))}.map(name => [name, process.env[name] ?? null]));\n` +
        `console.log(JSON.stringify({type: 'thread.started', thread_id: 'environment-thread'}));\n` +
        `console.log(JSON.stringify({type: 'item.completed', item: {id: 'message', type: 'agent_message', text: JSON.stringify(observed)}}));\n` +
        `console.log(JSON.stringify({type: 'turn.completed', usage: {input_tokens: 1, cached_input_tokens: 0, output_tokens: 1}}));\n`,
    );
    await chmod(cli, 0o700);
    const options: CodexOptions = { codexPathOverride: cli };
    if (configuration === 'empty') {
      options.env = {};
    } else if (configuration === 'explicit') {
      options.env = {
        SDK_UNRELATED_TOKEN: 'explicit-token',
        CODEX_API_KEY: 'explicit-key',
      };
    } else if (configuration === 'inherited') {
      options.env = Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      );
    }
    const tool = nativeCodexTool(
      configuration === 'provided'
        ? { codex: new Codex(options) }
        : { codexOptions: options },
    );
    const context = {
      context: undefined,
      submission: { sessionId: 'session' },
      threadId: 'session',
      turnId: 'turn',
      callId: 'call',
      signal: new AbortController().signal,
    } as ToolCallContext;
    registerToolSessionOwner(context, {});
    const result = await invokeFunctionTool(
      tool,
      { prompt: 'Inspect the selected test variables', threadId: null },
      context,
      () => {},
    );
    const content = result.contentItems?.[0];
    expect(content?.type).toBe('inputText');
    if (content?.type !== 'inputText')
      throw new Error('Expected CLI text output');
    const observed = JSON.parse(JSON.parse(content.text).response);
    expect(observed).toEqual(
      configuration === 'empty'
        ? {
            SDK_UNRELATED_TOKEN: null,
            CODEX_API_KEY: selected.CODEX_API_KEY,
            HOME: null,
            HTTPS_PROXY: null,
            PYTHONPATH: null,
          }
        : configuration === 'explicit'
          ? {
              SDK_UNRELATED_TOKEN: 'explicit-token',
              CODEX_API_KEY: 'explicit-key',
              HOME: null,
              HTTPS_PROXY: null,
              PYTHONPATH: null,
            }
          : {
              ...selected,
              SDK_UNRELATED_TOKEN:
                configuration === 'default'
                  ? null
                  : selected.SDK_UNRELATED_TOKEN,
              PYTHONPATH:
                configuration === 'default' ? null : selected.PYTHONPATH,
            },
    );
  },
);
