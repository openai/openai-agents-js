import * as facade from '@openai/agents';
import * as owner from '@openai/agents-codex';
import facadeCjs = require('@openai/agents');
import ownerCjs = require('@openai/agents-codex');

new facade.NativeProvider({
  runtime: new ownerCjs.NativeRuntime(),
  apiKey: 'synthetic',
});
new facadeCjs.NativeProvider({
  runtime: new owner.NativeRuntime(),
  apiKey: 'synthetic',
});
new owner.NativeProvider({
  runtime: new facadeCjs.NativeRuntime(),
  apiKey: 'synthetic',
});
new ownerCjs.NativeProvider({
  runtime: new facade.NativeRuntime(),
  apiKey: 'synthetic',
});

new facade.Agent({
  instructions: 'Delegate.',
  handoffs: [new ownerCjs.Agent({ instructions: 'Handle the handoff.' })],
});
new ownerCjs.Agent({
  instructions: 'Delegate.',
  handoffs: [new facade.Agent({ instructions: 'Handle the handoff.' })],
});
new facadeCjs.Agent({
  instructions: 'Delegate.',
  handoffs: [new owner.Agent({ instructions: 'Handle the handoff.' })],
});
new owner.Agent({
  instructions: 'Delegate.',
  handoffs: [new facadeCjs.Agent({ instructions: 'Handle the handoff.' })],
});

const esmLease: facade.EnvironmentLease = ownerCjs.Environment.lease(
  facade.Environment.local({ cwd: '.' }),
  () => {},
);
const cjsLease: facadeCjs.EnvironmentLease = owner.Environment.lease(
  facadeCjs.Environment.local({ cwd: '.' }),
  () => {},
);
const ownerEsmLease: owner.EnvironmentLease = facadeCjs.Environment.lease(
  owner.Environment.local({ cwd: '.' }),
  () => {},
);
const ownerCjsLease: ownerCjs.EnvironmentLease = facade.Environment.lease(
  ownerCjs.Environment.local({ cwd: '.' }),
  () => {},
);
void [esmLease, cjsLease, ownerEsmLease, ownerCjsLease];
