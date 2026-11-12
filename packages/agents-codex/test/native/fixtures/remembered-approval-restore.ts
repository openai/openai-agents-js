import { appendFileSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { Agent, NativeProvider, parseSessionState, tool } from '../../../src';

async function main() {
  const [statePath, effectsPath, baseUrl] = process.argv.slice(2);
  const risky = tool({
    name: 'risky',
    parameters: z.object({ value: z.string() }),
    needsApproval: true,
    approvalKey: 'fixture.risky.v1',
    execute: ({ value }) => {
      appendFileSync(effectsPath, value + '\n');
      return value;
    },
  });
  await using provider = new NativeProvider({
    baseUrl,
    apiKey: 'synthetic-function-approval',
    supportsWebsockets: false,
  });
  const agent = new Agent({
    instructions: 'Use the tool.',
    model: 'fixture',
    provider,
    tools: [risky],
  });
  await using session = await agent.session({
    state: parseSessionState(readFileSync(statePath, 'utf8')),
  });
  const turn = await session.submit('continue');
  const result = await Promise.race([
    turn.wait(),
    new Promise<never>((_, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Remembered approval did not resume')),
        10_000,
      );
      timer.unref();
    }),
  ]);
  if (
    result.finalOutput !== 'restored' ||
    (await session.pendingInteractions()).length !== 0
  )
    throw new Error('Invalid restored result');
  console.log(
    JSON.stringify({
      effects: readFileSync(effectsPath, 'utf8').split('\n').filter(Boolean),
    }),
  );
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
