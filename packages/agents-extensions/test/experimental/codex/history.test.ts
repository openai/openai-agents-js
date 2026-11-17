import { expect, test, vi } from 'vitest';
import {
  prepareCodexHistory,
  verifyAudioModel,
} from '../../../src/experimental/codex/history';

test('replays stored function outputs by call ID when the service omits the tool identity', () => {
  const call = {
    type: 'function_call' as const,
    name: 'lookup',
    namespace: 'crm',
    callId: 'call-42',
    arguments: '{}',
    status: 'in_progress' as const,
  };
  const storedResult = {
    type: 'function_call_result' as const,
    name: call.callId,
    callId: call.callId,
    output: { type: 'text' as const, text: 'Avery' },
    status: 'completed' as const,
  };
  const { history } = prepareCodexHistory([call, storedResult]);
  expect(history).toEqual([
    {
      type: 'function_call',
      name: 'lookup',
      namespace: 'crm',
      call_id: 'call-42',
      arguments: '{}',
    },
    {
      type: 'function_call_output',
      call_id: 'call-42',
      output: [{ type: 'input_text', text: 'Avery' }],
    },
  ]);
  expect(() =>
    prepareCodexHistory([call, { ...storedResult, name: 'other' }]),
  ).toThrow('match');
  expect(() =>
    prepareCodexHistory([call, { ...storedResult, namespace: 'other' }]),
  ).toThrow('match');
  expect(() => prepareCodexHistory([storedResult])).toThrow('match');
});

test('replays tool search and opaque reasoning with provider wire fields', () => {
  const result = prepareCodexHistory([
    {
      type: 'tool_search_call',
      id: 'tsc',
      callId: 'search',
      arguments: { query: 'lookup' },
      execution: 'client',
    },
    {
      type: 'tool_search_output',
      id: 'tso',
      callId: 'search',
      execution: 'client',
      status: 'completed',
      toolSearchAgentName: 'Guide',
      tools: [
        {
          type: 'namespace',
          name: 'catalog',
          tools: [{ type: 'function', name: 'lookup', deferLoading: true }],
        },
      ],
    },
    {
      type: 'reasoning',
      id: 'rs',
      content: [{ type: 'input_text', text: 'Summary' }],
      providerData: { encryptedContent: 'opaque' },
    },
    { role: 'user', content: 'Continue' },
  ]);
  expect(result.history).toEqual([
    {
      type: 'tool_search_call',
      id: 'tsc',
      call_id: 'search',
      arguments: { query: 'lookup' },
      execution: 'client',
    },
    {
      type: 'tool_search_output',
      id: 'tso',
      call_id: 'search',
      execution: 'client',
      status: 'completed',
      tools: [
        {
          type: 'namespace',
          name: 'catalog',
          tools: [{ type: 'function', name: 'lookup', defer_loading: true }],
        },
      ],
    },
    {
      type: 'reasoning',
      id: 'rs',
      summary: [{ type: 'summary_text', text: 'Summary' }],
      encrypted_content: 'opaque',
    },
  ]);
});

test('rejects a cache breakpoint before the stock process can discard it', () => {
  expect(() =>
    prepareCodexHistory([
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: 'cache',
            promptCacheBreakpoint: { mode: 'explicit' },
          },
        ],
      },
    ]),
  ).toThrow('promptCacheBreakpoint');
});

test('checks audio on the selected model and follows the model catalog cursor', async () => {
  const prepared = prepareCodexHistory([
    {
      role: 'user',
      content: [{ type: 'audio', format: 'wav', audio: 'UklGRg==' }],
    },
  ]);
  expect(prepared.turnInput).toEqual([
    { type: 'audio', url: 'data:audio/wav;base64,UklGRg==' },
  ]);
  const request = vi
    .fn()
    .mockResolvedValueOnce({ data: [], nextCursor: 'page2' })
    .mockResolvedValueOnce({
      data: [{ model: 'audio-model', inputModalities: ['audio'] }],
    });
  await verifyAudioModel(prepared, 'audio-model', { request });
  expect(request).toHaveBeenLastCalledWith('model/list', {
    includeHidden: true,
    cursor: 'page2',
  });
  request.mockResolvedValue({
    data: [{ model: 'text-model', inputModalities: ['text'] }],
  });
  await expect(
    verifyAudioModel(prepared, 'text-model', { request }),
  ).rejects.toThrow('advertises audio');
});

test('preserves SDK executor names and structured results across a handoff', () => {
  const r = prepareCodexHistory([
    {
      type: 'shell_call',
      callId: 'sh',
      action: { commands: ['pwd'], timeoutMs: 100 },
      providerData: { codexToolName: 'project_shell' },
    },
    {
      type: 'shell_call_output',
      callId: 'sh',
      status: 'completed',
      output: [
        {
          stdout: '/project',
          stderr: '',
          outcome: { type: 'exit', exitCode: 0 },
        },
      ],
    },
    {
      type: 'apply_patch_call',
      callId: 'ed',
      status: 'completed',
      operation: {
        type: 'update_file',
        path: 'before',
        moveTo: 'after',
        diff: '@@',
      },
    },
    {
      type: 'apply_patch_call_output',
      callId: 'ed',
      status: 'failed',
      output: 'denied',
    },
  ]);
  expect(r.history).toEqual([
    {
      type: 'function_call',
      namespace: 'agents_sdk',
      name: 'project_shell',
      call_id: 'sh',
      arguments: JSON.stringify({
        action: { commands: ['pwd'], timeout_ms: 100 },
      }),
    },
    {
      type: 'function_call_output',
      call_id: 'sh',
      output: JSON.stringify({
        status: 'completed',
        output: [
          {
            stdout: '/project',
            stderr: '',
            outcome: { type: 'exit', exit_code: 0 },
          },
        ],
      }),
    },
    {
      type: 'function_call',
      namespace: 'agents_sdk',
      name: 'apply_patch',
      call_id: 'ed',
      arguments: JSON.stringify({
        operation: {
          type: 'update_file',
          path: 'before',
          diff: '@@',
          move_to: 'after',
        },
      }),
    },
    {
      type: 'function_call_output',
      call_id: 'ed',
      output: JSON.stringify({ status: 'failed', output: 'denied' }),
    },
  ]);
});
