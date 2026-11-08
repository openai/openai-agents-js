import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  NativeProvider,
  tool,
  type PrepareRequestContext,
} from '../../src';
import {
  jsonObject,
  type JsonObject,
  type JsonValue,
} from '../../src/runtime/binding';
import { ModelServer, message } from './fixtures/model-server';

const usage = { input_tokens: 7, output_tokens: 3, total_tokens: 10 };
const fallbackUsage = { input_tokens: 10, output_tokens: 4, total_tokens: 14 };

function questions(request: JsonObject): JsonObject[] {
  return z.array(z.record(z.string(), z.any())).parse(request.questions);
}
function choose(
  question: JsonObject,
  selected: string,
  probability = 1,
): JsonObject {
  const choices = z
    .array(z.object({ value: z.string() }))
    .parse(question.choices);
  return {
    type: 'choice',
    name: question.name,
    choice: selected,
    confidence: 1,
    probabilities: choices.map(({ value }) => ({
      value,
      probability:
        value === selected
          ? probability
          : (1 - probability) / (choices.length - 1),
    })),
  };
}
function fieldAnswer(question: JsonObject): JsonObject {
  if (question.type === 'predicate')
    return { type: 'predicate', name: question.name, probability: 0.75 };
  if (question.type === 'score') {
    const levels = z
      .array(z.object({ label: z.string() }))
      .parse(question.levels);
    return {
      type: 'score',
      name: question.name,
      score: 1,
      confidence: 1,
      probabilities: levels.map(({ label }, value) => ({
        label,
        value,
        probability: value === 1 ? 1 : 0,
      })),
    };
  }
  return choose(question, 'value_1');
}
function decision(
  requestId: string | undefined,
  answers: JsonObject[],
  model = 'decision-model',
) {
  return {
    status: 200,
    headers: {
      'content-type': 'application/json',
      ...(requestId === undefined ? {} : { 'x-request-id': requestId }),
    },
    body: JSON.stringify({ answers, model, usage }),
  };
}
function route(id: string, selected: string, probability = 1) {
  return (request: JsonObject) => {
    expect(questions(request)).toHaveLength(1);
    expect(questions(request)[0]).toMatchObject({
      name: 'route',
      type: 'choice',
    });
    return decision(id, [choose(questions(request)[0], selected, probability)]);
  };
}
async function providerFor(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-decisions',
  });
}
function lookupDeclarations(request: JsonObject): JsonObject[] {
  const result: JsonObject[] = [];
  const add = (values: JsonValue) => {
    if (!Array.isArray(values)) return;
    for (const value of values) {
      const declaration = jsonObject.parse(value);
      if (declaration.type === 'namespace') add(declaration.tools ?? []);
      else if (declaration.type === 'function' && declaration.name === 'lookup')
        result.push(declaration);
    }
  };
  add(request.tools ?? []);
  if (Array.isArray(request.input)) {
    for (const value of request.input) {
      const item = jsonObject.parse(value);
      if (item.type === 'additional_tools') add(item.tools ?? []);
    }
  }
  return result;
}
function fixturePaths(server: ModelServer) {
  const paths: string[] = [];
  server.onRecord = (phase, detail) => {
    if (phase === 'MODEL_REQUEST')
      paths.push((detail as { path: string }).path);
  };
  return paths;
}
function lookup(
  execute: (value: string) => string | Promise<string> = (value) => value,
) {
  return tool({
    name: 'lookup',
    description: 'Look up a bounded category.',
    parameters: z.strictObject({ category: z.enum(['billing', 'technical']) }),
    execute: ({ category }) => execute(category),
  });
}

afterEach(async () => {
  await ModelServer.closeAll();
});

describe.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1')(
  'native Decisions',
  () => {
    it.each([true, false])(
      'fills typed final output and reports physical usage with x-request-id=%s',
      async (withRequestId) => {
        const declaredModel = withRequestId ? 'decision-model' : undefined;
        const expectedModel = declaredModel ?? 'gpt-6-luna';
        const server = new ModelServer([
          (request) => {
            expect(request.model).toBe(expectedModel);
            expect(JSON.stringify(request.input)).toContain(
              'FULL_INSTRUCTIONS',
            );
            expect(JSON.stringify(request.input)).toContain('USER_MARKER');
            expect(questions(request).map((question) => question.name)).toEqual(
              ['field_1', 'field_2', 'field_3', 'field_4'],
            );
            return decision(
              withRequestId ? 'typed-final' : undefined,
              questions(request).map(fieldAnswer),
              'resolved-decision-model',
            );
          },
        ]);
        const paths = fixturePaths(server);
        await using provider = await providerFor(server);
        await using session = await new Agent({
          instructions: 'FULL_INSTRUCTIONS',
          provider,
          model: declaredModel,
          api: 'decisions',
          outputType: z.strictObject({
            approved: z.boolean(),
            category: z.enum(['billing', 'technical']),
            probability: z.number().min(0).max(1),
            score: z.number().int().min(1).max(3),
          }),
        }).session();
        const result = await (await session.submit('USER_MARKER')).wait();
        expect(result.finalOutput).toEqual({
          approved: true,
          category: 'technical',
          probability: 0.75,
          score: 2,
        });
        expect(result.threadUsage?.totalTokenUsage.totalTokens).toBe(10);
        const records = [];
        for await (const record of session.turns()) records.push(record);
        const responses = records.flatMap((record) => record.responses ?? []);
        expect(responses).toHaveLength(1);
        expect(responses[0].responseId).toEqual(expect.any(String));
        expect(responses[0].responseId?.trim()).not.toBe('');
        expect(responses[0].responseId).not.toBe('typed-final');
        expect(responses[0].usage?.totalTokens).toBe(10);
        expect(paths).toEqual(['/v1/decisions']);
        server.assertExhausted();
      },
    );

    it('delegates through a function to an ordinary specialist and resumes the Decisions coordinator', async () => {
      const effects: string[] = [];
      const selectionRule =
        'SPECIALTY_SELECTION_RULE: option_a means billing support; option_b means technical support.';
      const server = new ModelServer(
        [
          route('tool-route', 'route_1'),
          (request) => {
            const fields = questions(request);
            expect(fields).toHaveLength(1);
            expect(JSON.stringify(fields)).toContain(
              'SPECIALTY_SELECTION_RULE',
            );
            expect(JSON.stringify(fields)).toContain('consult_specialist');
            expect(fields[0].name).toBe('field_1');
            return decision('tool-arguments', fields.map(fieldAnswer));
          },
          (request) => {
            expect(request.model).toBe('ordinary-specialist');
            expect(JSON.stringify(request.input)).toContain('technical');
            return [message('LOOKUP_RESULT')];
          },
          (request) => {
            expect(JSON.stringify(request.input)).toContain('LOOKUP_RESULT');
            expect(JSON.stringify(request.input)).toContain('ORIGINAL_PROMPT');
            return route('final-route', 'route_0')(request);
          },
        ],
        [
          JSON.stringify(usage),
          JSON.stringify(usage),
          JSON.stringify(fallbackUsage),
          JSON.stringify(usage),
        ],
      );
      const paths = fixturePaths(server);
      await using provider = await providerFor(server);
      const specialist = new Agent({
        instructions: 'Answer the lookup.',
        provider,
        model: 'ordinary-specialist',
      });
      await using session = await new Agent({
        instructions: 'Use consult_specialist and return done.',
        provider,
        api: 'decisions',
        outputType: z.strictObject({ status: z.literal('done') }),
        tools: [
          tool({
            name: 'consult_specialist',
            description: selectionRule,
            parameters: z.strictObject({
              selection: z.enum(['option_a', 'option_b']),
            }),
            execute: async ({ selection }) => {
              effects.push(selection);
              const specialty =
                selection === 'option_a' ? 'billing' : 'technical';
              const result = await specialist.run(specialty);
              expect(result.threadUsage?.totalTokenUsage.totalTokens).toBe(14);
              return result.finalOutput;
            },
          }),
        ],
      }).session();
      const turn = await session.submit('ORIGINAL_PROMPT');
      const result = await turn.wait();
      expect(result.finalOutput).toEqual({ status: 'done' });
      expect(effects).toEqual(['option_b']);
      expect(paths).toEqual([
        '/v1/decisions',
        '/v1/decisions',
        '/v1/responses',
        '/v1/decisions',
      ]);
      expect(result.threadUsage?.totalTokenUsage.totalTokens).toBe(30);
      const events = [];
      for await (const event of turn.events()) events.push(event);
      const dispatches = events.filter(
        (event) => event.type === 'model_request_dispatching',
      );
      expect(dispatches).toHaveLength(3);
      for (const event of dispatches)
        expect(event).toMatchObject({
          wire: 'decisions',
          transport: 'http_json',
          model: 'gpt-6-luna',
        });
      const records = [];
      for await (const record of session.turns()) records.push(record);
      const responses = records.flatMap((record) => record.responses ?? []);
      expect(responses).toHaveLength(3);
      const responseIds = responses.map((response) => response.responseId);
      expect(
        responseIds.every(
          (id) => typeof id === 'string' && id.trim().length > 0,
        ),
      ).toBe(true);
      expect(new Set(responseIds).size).toBe(3);
      expect(responseIds).not.toContain('tool-route');
      expect(responseIds).not.toContain('tool-arguments');
      expect(responseIds).not.toContain('final-route');
      expect(responses.map((response) => response.usage?.totalTokens)).toEqual([
        10, 10, 10,
      ]);
      const links = events.filter(
        (event) => event.type === 'model_response_linked',
      );
      expect(links.map((event) => event.requestId)).toEqual(
        dispatches.map((event) => event.requestId),
      );
      expect(links.map((event) => event.responseObservationId)).toEqual(
        responses.map((response) => response.id),
      );
      server.assertExhausted();
    });

    it('dispatches the selected namespace when eager functions share a short name', async () => {
      const effects: string[] = [];
      const server = new ModelServer([
        route('namespaced-route', 'route_2'),
        (request) => {
          const fields = questions(request);
          expect(fields).toHaveLength(1);
          expect(JSON.stringify(fields)).toContain('support');
          expect(JSON.stringify(fields)).toContain('lookup');
          return decision('namespaced-fields', fields.map(fieldAnswer));
        },
        (request) => {
          expect(JSON.stringify(request.input)).toContain(
            'NAMESPACED_LOOKUP_RESULT',
          );
          return route('namespaced-final', 'route_0')(request);
        },
      ]);
      const paths = fixturePaths(server);
      await using provider = await providerFor(server);
      const lookupIn = (namespace: string) =>
        tool({
          name: 'lookup',
          namespace,
          description: 'Look up the selected category.',
          parameters: z.strictObject({
            category: z.enum(['billing', 'technical']),
          }),
          execute: ({ category }) => {
            effects.push(`${namespace}:${category}`);
            return 'NAMESPACED_LOOKUP_RESULT';
          },
        });
      const agent = new Agent({
        instructions: 'Use the selected lookup and return done.',
        provider,
        api: 'decisions',
        tools: [lookupIn('sales'), lookupIn('support')],
        outputType: z.strictObject({ status: z.literal('done') }),
      });
      const result = await agent.run('Look up the technical category.');
      expect(result.finalOutput).toEqual({ status: 'done' });
      expect(effects).toEqual(['support:technical']);
      expect(result.threadUsage?.totalTokenUsage.totalTokens).toBe(30);
      expect(paths).toEqual([
        '/v1/decisions',
        '/v1/decisions',
        '/v1/decisions',
      ]);
      server.assertExhausted();
    });

    it.each([
      'unsupported selected route',
      'low selected probability',
    ] as const)(
      'uses explicit fallback for %s while retaining the full prompt and all usage',
      async (reason) => {
        const fallbackModel =
          reason === 'low selected probability'
            ? 'gpt-6-luna'
            : 'ordinary-fallback';
        const execute = vi.fn(() => 'not executed');
        const server = new ModelServer(
          [
            (request) => {
              expect(request.model).toBe('decision-model');
              return route(
                'selected-route',
                reason === 'unsupported selected route' ? 'route_0' : 'route_1',
                reason === 'low selected probability' ? 0.2 : 1,
              )(request);
            },
            (request) => {
              expect(request.model).toBe(fallbackModel);
              expect(JSON.stringify(request.input)).toContain(
                'FULL_FALLBACK_INSTRUCTIONS',
              );
              expect(JSON.stringify(request.input)).toContain(
                'FULL_FALLBACK_USER_INPUT',
              );
              const declarations = lookupDeclarations(request);
              expect(declarations).toHaveLength(1);
              expect(declarations[0].parameters).toMatchObject({
                type: 'object',
                additionalProperties: false,
                required: ['category'],
                properties: {
                  category: { type: 'string', enum: ['billing', 'technical'] },
                },
              });
              return [message('fallback answer')];
            },
          ],
          [JSON.stringify(usage), JSON.stringify(fallbackUsage)],
        );
        const paths = fixturePaths(server);
        await using provider = await providerFor(server);
        await using session = await new Agent({
          instructions: 'FULL_FALLBACK_INSTRUCTIONS',
          provider,
          model: 'decision-model',
          api: 'decisions',
          fallbackModel,
          minRouteProbability: 0.8,
          tools: [lookup(execute)],
        }).session();
        const result = await (
          await session.submit('FULL_FALLBACK_USER_INPUT')
        ).wait();
        expect(result.finalOutput).toBe('fallback answer');
        expect(result.threadUsage?.totalTokenUsage.totalTokens).toBe(24);
        const records = [];
        for await (const record of session.turns()) records.push(record);
        const responses = records.flatMap((record) => record.responses ?? []);
        expect(responses).toHaveLength(2);
        expect(responses[0].responseId).toEqual(expect.any(String));
        expect(responses[0].responseId?.trim()).not.toBe('');
        expect(responses[0].responseId).not.toBe('selected-route');
        expect(responses[1].responseId).toBe('response-2');
        expect(
          new Set(responses.map((response) => response.responseId)).size,
        ).toBe(2);
        expect(
          responses.map((response) => response.usage?.totalTokens),
        ).toEqual([10, 14]);
        expect(execute).not.toHaveBeenCalled();
        expect(paths).toEqual(['/v1/decisions', '/v1/responses']);
        server.assertExhausted();
      },
    );

    it.each(['refusal', 'invalid field answer', 'provider error'] as const)(
      'does not reselect or fall back after %s on a supported route',
      async (failure) => {
        const execute = vi.fn(() => 'not executed');
        const server = new ModelServer([
          route('selected-route', 'route_1'),
          (request) => {
            const question = questions(request)[0];
            expect(question.name).toBe('field_1');
            if (failure === 'provider error')
              return {
                status: 400,
                body: JSON.stringify({
                  error: {
                    message: 'synthetic provider failure',
                    type: 'invalid_request_error',
                  },
                }),
              };
            return decision('failed-fields', [
              failure === 'refusal'
                ? { name: question.name, type: 'refusal' }
                : { ...choose(question, 'value_1'), choice: 'invalid-choice' },
            ]);
          },
        ]);
        const paths = fixturePaths(server);
        await using provider = await providerFor(server);
        const agent = new Agent({
          instructions: 'Use lookup.',
          provider,
          model: 'decision-model',
          api: 'decisions',
          fallbackModel: 'ordinary-fallback',
          tools: [lookup(execute)],
        });
        await expect(agent.run('Choose lookup.')).rejects.toThrow();
        expect(execute).not.toHaveBeenCalled();
        expect(paths).toEqual(['/v1/decisions', '/v1/decisions']);
        server.assertExhausted();
      },
    );

    it('composes native request preparation with the captured application context', async () => {
      const context = { marker: 'CONTEXT_MARKER' };
      const prepare = vi.fn(
        ({
          request,
          context: supplied,
        }: PrepareRequestContext<{ marker: string }>) => {
          expect(supplied).toBe(context);
          request.instructions += ` EDITED_${supplied.marker}`;
          request.input.push({
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'PREPARED_INPUT' }],
          });
          return request;
        },
      );
      const server = new ModelServer([
        (request) => {
          expect(JSON.stringify(request.input)).toContain(
            'EDITED_CONTEXT_MARKER',
          );
          expect(JSON.stringify(request.input)).toContain('PREPARED_INPUT');
          return decision(
            'prepared-final',
            questions(request).map(fieldAnswer),
          );
        },
      ]);
      await using provider = await providerFor(server);
      const result = await new Agent<
        { marker: string },
        { category: 'billing' | 'technical' }
      >({
        instructions: 'Original instructions.',
        provider,
        model: 'decision-model',
        api: 'decisions',
        outputType: z.strictObject({
          category: z.enum(['billing', 'technical']),
        }),
      }).run('Choose.', { context, prepareRequest: prepare });
      expect(result.finalOutput).toEqual({ category: 'technical' });
      expect(prepare).toHaveBeenCalled();
      server.assertExhausted();
    });

    it('keeps Azure-shaped provider compaction readable by the next Decisions turn', async () => {
      const summary = 'COMPACTED_DECISIONS_CONTEXT';
      let encryptedCompactionRequested = false;
      const server = new ModelServer([
        (request) =>
          decision('before-compaction', questions(request).map(fieldAnswer)),
        (request) => {
          expect(request.model).toBe('ordinary-fallback');
          encryptedCompactionRequested =
            Array.isArray(request.input) &&
            request.input.some(
              (item) => jsonObject.parse(item).type === 'compaction_trigger',
            );
          // Both replies are valid for the requested compaction mode. A remote
          // encrypted item must never become the Decisions classifier's input.
          return encryptedCompactionRequested
            ? [
                {
                  type: 'compaction',
                  encrypted_content: 'SYNTHETIC_ENCRYPTED_CONTEXT',
                },
              ]
            : [message(summary)];
        },
        (request) => {
          expect(JSON.stringify(request.input)).toContain(summary);
          return decision(
            'after-compaction',
            questions(request).map(fieldAnswer),
          );
        },
      ]);
      const paths = fixturePaths(server);
      const config = await server.config();
      const baseUrl = (
        config['model_providers.fixture'] as { base_url: string }
      ).base_url.replace(/\/v1$/, '/azure-api.test/v1');
      await using provider = new NativeProvider({
        baseUrl,
        apiKey: 'synthetic-azure-decisions',
        supportsWebsockets: false,
      });
      await using session = await new Agent({
        instructions: 'Classify the request category.',
        provider,
        model: 'decision-model',
        api: 'decisions',
        fallbackModel: 'ordinary-fallback',
        outputType: z.strictObject({
          category: z.enum(['billing', 'technical']),
        }),
      }).session();
      expect(
        (await (await session.submit('Classify before compaction.')).wait())
          .finalOutput,
      ).toEqual({ category: 'technical' });
      await session.compact();
      expect(
        (await (await session.submit('Classify after compaction.')).wait())
          .finalOutput,
      ).toEqual({ category: 'technical' });
      expect(encryptedCompactionRequested).toBe(false);
      expect(paths).toEqual([
        '/azure-api.test/v1/decisions',
        '/azure-api.test/v1/responses',
        '/azure-api.test/v1/decisions',
      ]);
      server.assertExhausted();
    });

    it('retains completed routing usage when cancellation interrupts field filling', async () => {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const server = new ModelServer([
        route('completed-route', 'route_1'),
        async (request) => {
          entered.resolve();
          await release.promise;
          return decision(
            'cancelled-fields',
            questions(request).map(fieldAnswer),
          );
        },
      ]);
      await using provider = await providerFor(server);
      await using session = await new Agent({
        instructions: 'Use lookup.',
        provider,
        model: 'decision-model',
        api: 'decisions',
        tools: [lookup()],
      }).session();
      try {
        const turn = await session.submit('Choose lookup.');
        const completion = turn.wait();
        void completion.catch(() => undefined);
        await entered.promise;
        await turn.cancel();
        await expect(completion).rejects.toThrow();
        const events = [];
        for await (const event of turn.events()) events.push(event);
        expect(
          events.some(
            (event) =>
              event.type === 'usage_updated' &&
              event.usage?.totalTokenUsage.totalTokens === 10,
          ),
        ).toBe(true);
        const records = [];
        for await (const record of session.turns()) records.push(record);
        const responses = records.flatMap((record) => record.responses ?? []);
        expect(responses).toHaveLength(1);
        expect(responses[0].responseId).toEqual(expect.any(String));
        expect(responses[0].responseId?.trim()).not.toBe('');
        expect(responses[0].responseId).not.toBe('completed-route');
        expect(responses[0].usage?.totalTokens).toBe(10);
        expect(server.requests).toHaveLength(2);
      } finally {
        release.resolve();
      }
    });
  },
);
