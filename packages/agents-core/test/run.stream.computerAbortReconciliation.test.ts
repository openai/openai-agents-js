import { beforeAll, describe, expect, it } from 'vitest';

import {
  Agent,
  AgentInputItem,
  ModelRequest,
  StreamEvent,
  Usage,
  run,
  setDefaultModelProvider,
  setTracingDisabled,
} from '../src';
import { COMPUTER_FALLBACK_SCREENSHOT_DATA_URL } from '../src/runner/streamReconciliation';
import {
  ScriptedModel,
  modelResponse,
  modelStreamResponder,
} from '../src/testing';
import { ScriptedModelProvider, fakeModelMessage } from './stubs';

function getRequestInputItems(request: ModelRequest): AgentInputItem[] {
  return Array.isArray(request.input) ? request.input : [];
}

class AbortAfterStreamedComputerCallModel extends ScriptedModel {
  constructor(responseId: string) {
    super([
      modelStreamResponder(() =>
        (async function* () {
          yield {
            type: 'model',
            event: {
              type: 'response.created',
              response: { id: responseId },
            },
          } as StreamEvent;
          yield {
            type: 'model',
            event: {
              type: 'response.output_item.done',
              item: {
                type: 'computer_call',
                id: 'computer_abort',
                call_id: 'call_computer_abort',
                status: 'completed',
                action: { type: 'screenshot' },
              },
            },
          } as StreamEvent;
          const error = new Error('aborted');
          error.name = 'AbortError';
          throw error;
        })(),
      ),
      modelResponse({
        output: [fakeModelMessage('reconciled')],
        usage: new Usage(),
        responseId: 'resp-reconciled',
      }),
    ]);
  }

  get requests(): readonly Readonly<ModelRequest>[] {
    return this.calls.map((call) => call.request);
  }
}

describe('streamed computer abort reconciliation', () => {
  beforeAll(() => {
    setTracingDisabled(true);
    setDefaultModelProvider(new ScriptedModelProvider());
  });

  it('forces tool choice none while preserving server-managed context', async () => {
    const model = new AbortAfterStreamedComputerCallModel('resp-aborted');
    const agent = new Agent({
      name: 'AbortComputerReconcile',
      model,
      modelSettings: { toolChoice: 'required' },
    });

    const result = await run(agent, 'hi', {
      stream: true,
      conversationId: 'conv-computer-abort',
    });

    await result.completed;

    expect(model.requests).toHaveLength(2);
    expect(model.requests[0].modelSettings.toolChoice).toBe('required');

    const reconciliationRequest = model.requests[1];
    expect(reconciliationRequest.conversationId).toBe('conv-computer-abort');
    expect(reconciliationRequest.signal).toBeUndefined();
    expect(reconciliationRequest.modelSettings.toolChoice).toBe('none');
    expect(getRequestInputItems(reconciliationRequest)).toEqual([
      {
        type: 'computer_call_result',
        callId: 'call_computer_abort',
        output: {
          type: 'computer_screenshot',
          data: COMPUTER_FALLBACK_SCREENSHOT_DATA_URL,
        },
        providerData: { status: 'incomplete' },
      },
    ]);
  });
});
