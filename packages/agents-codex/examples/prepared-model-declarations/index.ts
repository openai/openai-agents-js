import { pathToFileURL } from 'node:url';
import {
  Agent,
  Runner,
  tool,
  type Model,
  type ModelRequest,
} from '@openai/agents/classic';
import {
  ScriptedModel,
  assistantMessage,
  functionCall,
  modelResponse,
} from '@openai/agents/classic/testing';
import { z } from 'zod';

type PreparedInput = Pick<
  ModelRequest,
  'systemInstructions' | 'input' | 'tools'
>;

/** Edit detached sampling data, without replacing the Runner's registered tools. */
export function withPreparedRequest(
  model: Model,
  edit: (input: PreparedInput) => void,
): Model {
  function prepare(request: ModelRequest): ModelRequest {
    // Serialized declarations can still share nested schemas with registered tools.
    const prepared = structuredClone({
      systemInstructions: request.systemInstructions,
      input: request.input,
      tools: request.tools,
    });
    edit(prepared);
    return { ...request, ...prepared };
  }
  return {
    supportsPromptModelSelection: model.supportsPromptModelSelection,
    getRetryAdvice: model.getRetryAdvice?.bind(model),
    getResponse: (request) => model.getResponse(prepare(request)),
    getStreamedResponse: (request) =>
      model.getStreamedResponse(prepare(request)),
  };
}

/** An offline response-mode run; the application makes the approval decision. */
export async function runPreparedDeclarationsExample() {
  const bookings: number[] = [];
  const reserve = tool({
    name: 'reserve_seats',
    description: 'Reserve up to three seats.',
    parameters: z.object({ seats: z.number().int().min(1).max(3) }),
    needsApproval: true,
    execute: ({ seats }) => {
      bookings.push(seats);
      return `Reserved ${seats} seats.`;
    },
  });
  const erase = tool({
    name: 'erase_bookings',
    description: 'Erase all bookings.',
    parameters: z.object({}),
    isEnabled: false,
    execute: () => {
      throw new Error('A disabled tool must not execute');
    },
  });
  const sampling = new ScriptedModel([
    modelResponse([
      functionCall('reserve_seats', '{"seats":2}', { callId: 'booking' }),
    ]),
    modelResponse([assistantMessage('Your two seats are reserved.')]),
  ]);
  const model = withPreparedRequest(sampling, (prepared) => {
    prepared.systemInstructions += '\nUse concise booking language.';
    if (typeof prepared.input === 'string') prepared.input += ' Please.';
    else
      prepared.input.push({
        role: 'user',
        content: 'Use the workshop schedule.',
      });
    const declaration = prepared.tools.find(
      (entry) => entry.type === 'function',
    );
    if (declaration?.type === 'function') {
      declaration.description = 'Reserve seats for this workshop.';
      // This affects sampling only. It cannot raise the registered limit of three.
      declaration.parameters.properties.seats = {
        type: 'integer',
        minimum: 1,
        maximum: 99,
      };
    }
  });
  const agent = new Agent({
    name: 'Bookings',
    instructions: 'Help with workshop bookings.',
    tools: [reserve, erase],
    model,
  });
  const runner = new Runner({ tracingDisabled: true });
  const pending = await runner.run(agent, 'Reserve two seats.');
  if (bookings.length !== 0 || pending.interruptions.length !== 1)
    throw new Error('Expected approval before the original handler runs');
  // In an application, show the request and wait for the user's decision here.
  pending.state.approve(pending.interruptions[0]);
  const result = await runner.run(agent, pending.state);
  sampling.assertComplete();
  return {
    finalOutput: result.finalOutput,
    bookings,
    sampledTools: sampling.firstCall?.request.tools,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  runPreparedDeclarationsExample()
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
}
