import { createGoogleGenerativeAI } from '@ai-sdk/google';
import OpenAI from 'openai';
import type * as Worker from '../../src/runtime/workerd';
import type { JsonObject } from '../../src/runtime/binding';

export const rawFileData = 'UEFTU0lWRV9QUk9WSURFUl9GSUxFXzczMQ==';
export const googleRawResponse = {
  responseId: 'portable_google_response',
  candidates: [
    {
      index: 0,
      finishReason: 'STOP',
      content: {
        role: 'model',
        parts: [
          { inlineData: { mimeType: 'image/png', data: rawFileData } },
          { text: 'Visible answer.' },
        ],
      },
    },
  ],
  usageMetadata: {
    promptTokenCount: 1,
    candidatesTokenCount: 1,
    totalTokenCount: 2,
  },
};
export const responsesRawOutput = {
  type: 'message',
  id: 'msg_portable_raw',
  role: 'assistant',
  status: 'completed',
  content: [{ type: 'output_text', text: 'Visible answer.', annotations: [] }],
};
export const responsesRawFrames: JsonObject[] = [
  { type: 'response.created', response: { id: 'resp_portable_raw' } },
  { type: 'response.portable_vendor', payload: { passive: rawFileData } },
  {
    type: 'response.output_text.delta',
    delta: 'Visible answer.',
    item_id: 'msg_portable_raw',
    output_index: 0,
    content_index: 0,
  },
  {
    type: 'response.completed',
    response: {
      id: 'resp_portable_raw',
      status: 'completed',
      output: [responsesRawOutput],
    },
  },
];

export async function workerRawProviderFixture(
  api: typeof Worker,
  control: WebAssembly.Module,
  baseUrl: string,
  carrier: 'google' | 'responses',
  capture: boolean,
) {
  const raw: JsonObject[] = [];
  const normalized: JsonObject[] = [];
  let snapshot: string | null = null;
  let held = false;
  const store: Worker.SessionStore = {
    async acquire() {
      if (held) throw new Error('Concurrent fixture writer');
      held = true;
      return 'fixture-fence';
    },
    async read() {
      return snapshot;
    },
    async commit(_id, _fence, _write, expected, value) {
      if ((snapshot === null ? 0 : JSON.parse(snapshot).revision) !== expected)
        throw new Error('Wrong fixture revision');
      snapshot = value;
    },
    async release() {
      held = false;
    },
  };
  const provider =
    carrier === 'google'
      ? new api.AiSdkModel(
          createGoogleGenerativeAI({
            baseURL: baseUrl,
            apiKey: 'synthetic-loopback-key',
          })('gemini-2.5-flash-image'),
          {},
          { stream: true },
        )
      : new api.ResponsesModel(
          new OpenAI({
            baseURL: baseUrl,
            apiKey: 'synthetic-loopback-key',
            dangerouslyAllowBrowser: true,
          }),
          'gpt-4.1',
          { stream: true },
        );
  for (const input of ['first', 'second']) {
    const result = await api.runWorkerText(input, {
      control,
      provider,
      model: carrier === 'google' ? 'gemini-2.5-flash-image' : 'gpt-4.1',
      instructions: 'Reply.',
      session: { id: 'portable-raw-fixture', store },
      observe: (event) => {
        normalized.push(JSON.parse(JSON.stringify(event)));
      },
      observeRaw: capture
        ? (part) => {
            raw.push(JSON.parse(JSON.stringify(part)));
            // Mutation must not change the adapter's pending semantic projection.
            if (part.type === 'text-delta')
              (part as JsonObject).delta = 'MUTATED RAW';
            if (part.type === 'response.output_text.delta')
              (part as JsonObject).delta = 'MUTATED RAW';
            if (part.type === 'file')
              ((part as JsonObject).data as JsonObject).data = 'MUTATED FILE';
          }
        : undefined,
    });
    if (result !== 'Visible answer.')
      throw new Error('Raw observer changed the model result');
  }
  return { raw, normalized, snapshot, held };
}

export async function stopWorkerRawFixture(
  api: typeof Worker,
  control: WebAssembly.Module,
  baseUrl: string,
  mode: 'throw' | 'abort',
) {
  const controller = new AbortController();
  const cause = new Error('raw observer stopped');
  let saved = false;
  let released = false;
  let observed = 0;
  const provider = new api.ResponsesModel(
    new OpenAI({
      baseURL: baseUrl,
      apiKey: 'synthetic-loopback-key',
      dangerouslyAllowBrowser: true,
    }),
    'gpt-4.1',
    { stream: true },
  );
  try {
    await api.runWorkerText('first', {
      control,
      provider,
      model: 'gpt-4.1',
      instructions: 'Reply.',
      signal: controller.signal,
      session: {
        id: 'raw-stop',
        store: {
          async acquire() {
            return 'fence';
          },
          async read() {
            return null;
          },
          async commit() {
            saved = true;
          },
          async release() {
            released = true;
          },
        },
      },
      observeRaw: () => {
        observed++;
        if (mode === 'abort') controller.abort(cause);
        else throw cause;
      },
    });
    throw new Error('Expected raw observer failure');
  } catch (error) {
    if (error !== cause) throw error;
  }
  if (saved || !released || observed !== 1)
    throw new Error('Raw observer escaped settlement');
  return { mode, observed, saved, released };
}
