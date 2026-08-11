import { describe, expect, expectTypeOf, it } from 'vitest';
import * as CoreTesting from '../src/testing';
import * as RealtimeTesting from '../src/realtime/testing';
import {
  ScriptedModel as CanonicalScriptedModel,
  scriptedSandboxSession as canonicalScriptedSandboxSession,
} from '@openai/agents-core/testing';
import { ScriptedRealtimeTransport as CanonicalScriptedRealtimeTransport } from '@openai/agents-realtime/testing';
import type { Model } from '@openai/agents-core';
import type { RealtimeTransportLayer } from '@openai/agents-realtime';

describe('testing convenience subpaths', () => {
  it('re-exports Core testing without mixing in Realtime', () => {
    expect(CoreTesting.ScriptedModel).toBe(CanonicalScriptedModel);
    expect(CoreTesting.scriptedSandboxSession).toBe(
      canonicalScriptedSandboxSession,
    );
    expect('ScriptedRealtimeTransport' in CoreTesting).toBe(false);
    expectTypeOf(new CoreTesting.ScriptedModel()).toMatchTypeOf<Model>();
    expectTypeOf(CoreTesting.scriptedSandboxSession([])).toMatchTypeOf<
      import('@openai/agents-core/sandbox').SandboxSession
    >();
  });

  it('re-exports Realtime testing from the nested subpath', () => {
    expect(RealtimeTesting.ScriptedRealtimeTransport).toBe(
      CanonicalScriptedRealtimeTransport,
    );
    expectTypeOf(
      new RealtimeTesting.ScriptedRealtimeTransport(),
    ).toMatchTypeOf<RealtimeTransportLayer>();
  });
});
