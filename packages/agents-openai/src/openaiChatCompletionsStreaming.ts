import type { Stream } from 'openai/streaming';
import type { CompletionUsage } from 'openai/resources/completions';
import { protocol } from '@openai/agents-core';
import { ChatCompletion, ChatCompletionChunk } from 'openai/resources/chat';
import { FAKE_ID } from './openaiChatCompletionsModel';

type StreamingState = {
  started: boolean;
  text_content_index_and_output: [number, protocol.OutputText] | null;
  refusal_content_index_and_output: [number, protocol.Refusal] | null;
  function_calls: Record<number, protocol.FunctionCallItem>;
};

export async function* convertChatCompletionsStreamToResponses(
  response: ChatCompletion,
  stream: Stream<ChatCompletionChunk>,
): AsyncIterable<protocol.StreamEvent> {
  let usage: CompletionUsage | undefined = undefined;
  const state: StreamingState = {
    started: false,
    text_content_index_and_output: null,
    refusal_content_index_and_output: null,
    function_calls: {},
  };

  for await (const chunk of stream) {
    if (!state.started) {
      state.started = true;
      yield {
        type: 'response_started',
        providerData: {
          ...chunk,
        },
      };
    }

    // always yield the raw event
    yield {
      type: 'model',
      event: chunk,
    };

    // This is always set by the OpenAI API, but not by others e.g. LiteLLM
    usage = (chunk as any).usage || undefined;

    if (!chunk.choices?.[0]?.delta) continue;
    const delta = chunk.choices[0].delta;

    // Handle text
    if (delta.content) {
      if (!state.text_content_index_and_output) {
        state.text_content_index_and_output = [
          !state.refusal_content_index_and_output ? 0 : 1,
          { text: '', type: 'output_text', providerData: { annotations: [] } },
        ];
      }
      yield {
        type: 'output_text_delta',
        delta: delta.content,
        providerData: {
          ...chunk,
        },
      };
      state.text_content_index_and_output[1].text += delta.content;
    }

    // Handle refusals
    if ('refusal' in delta && delta.refusal) {
      if (!state.refusal_content_index_and_output) {
        state.refusal_content_index_and_output = [
          !state.text_content_index_and_output ? 0 : 1,
          { refusal: '', type: 'refusal' },
        ];
      }
      state.refusal_content_index_and_output[1].refusal += delta.refusal;
    }

    // Handle tool calls
    if (delta.tool_calls) {
      for (const tc_delta of delta.tool_calls) {
        if (!(tc_delta.index in state.function_calls)) {
          state.function_calls[tc_delta.index] = {
            id: FAKE_ID,
            arguments: '',
            name: '',
            type: 'function_call',
            callId: '',
          };
        }
        const tc_function = tc_delta.function;
        state.function_calls[tc_delta.index].arguments +=
          tc_function?.arguments || '';
        state.function_calls[tc_delta.index].name += tc_function?.name || '';
        state.function_calls[tc_delta.index].callId += tc_delta.id || '';
      }
    }
  }

  // Final output message
  const outputs: protocol.OutputModelItem[] = [];
  if (
    state.text_content_index_and_output ||
    state.refusal_content_index_and_output
  ) {
    const assistant_msg: protocol.AssistantMessageItem = {
      id: FAKE_ID,
      content: [],
      role: 'assistant',
      type: 'message',
      status: 'completed',
    };
    if (state.text_content_index_and_output) {
      assistant_msg.content.push(state.text_content_index_and_output[1]);
    }
    if (state.refusal_content_index_and_output) {
      assistant_msg.content.push(state.refusal_content_index_and_output[1]);
    }
    outputs.push(assistant_msg);
  }

  for (const function_call of Object.values(state.function_calls)) {
    outputs.push(function_call);
  }

  // Compose final response
  const finalEvent: protocol.StreamEventResponseCompleted = {
    type: 'response_done',
    response: {
      id: response.id,
      usage: {
        inputTokens: usage?.prompt_tokens ?? 0,
        outputTokens: usage?.completion_tokens ?? 0,
        totalTokens: usage?.total_tokens ?? 0,
        inputTokensDetails: {
          cached_tokens: usage?.prompt_tokens_details?.cached_tokens ?? 0,
        },
        outputTokensDetails: {
          reasoning_tokens:
            (usage as any)?.completion_tokens_details?.reasoning_tokens ?? 0,
        },
      },
      output: outputs,
    },
  };

  yield finalEvent;
}
