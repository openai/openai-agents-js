import { describe, test, expect } from 'vitest';

import * as AgentsCore from '../src/index';
import * as Sandbox from '../src/sandbox';
import * as LocalSandbox from '../src/sandbox/local';

describe('index.ts', () => {
  test('has expected exports', () => {
    const agent = new AgentsCore.Agent({
      name: 'TestAgent',
      outputType: 'text',
    });
    expect(agent).toBeDefined();
    expect(agent.name).toEqual('TestAgent');
    expect(typeof AgentsCore.setSensitiveDataLoggingEnabled).toBe('function');
    expect(typeof AgentsCore.RunCompactionItem).toBe('function');
    expect(typeof AgentsCore.RunInputItem).toBe('function');
    expect(typeof AgentsCore.isSessionHistoryTransactionAwareSession).toBe(
      'function',
    );
  });

  test('does not expose sandbox exports from the top-level entry', () => {
    expect('SandboxAgent' in AgentsCore).toBe(false);
    expect('Manifest' in AgentsCore).toBe(false);
    expect('Capabilities' in AgentsCore).toBe(false);
    expect('filesystem' in AgentsCore).toBe(false);

    expect(typeof Sandbox.SandboxAgent).toBe('function');
    expect(typeof Sandbox.Manifest).toBe('function');
    expect(typeof Sandbox.Capabilities.default).toBe('function');
    expect(typeof Sandbox.filesystem).toBe('function');
    expect(typeof Sandbox.shell).toBe('function');
    expect(
      'manifestAcknowledgesInContainerMountCredentialExposure' in Sandbox,
    ).toBe(false);
    expect('MOUNT_CREDENTIAL_EXPOSURE_POLICY_KEYS' in Sandbox).toBe(false);
    expect('copyManifestMountCredentialExposurePolicy' in Sandbox).toBe(false);
    expect('replaceManifestMountCredentialExposurePolicy' in Sandbox).toBe(
      false,
    );
    expect('UnixLocalSandboxClient' in Sandbox).toBe(false);
    expect('DockerSandboxClient' in Sandbox).toBe(false);
    expect(typeof LocalSandbox.UnixLocalSandboxClient).toBe('function');
    expect(typeof LocalSandbox.DockerSandboxClient).toBe('function');
  });
});
