import {
  file,
  Manifest,
  SandboxProviderError,
  SandboxUnsupportedFeatureError,
  type SandboxSessionState,
} from '@openai/agents-core/sandbox';
import { describe, expect, test } from 'vitest';
import {
  assertCoreConcurrencyLimitsUnsupported,
  assertCoreSnapshotUnsupported,
  assertResumeRecreateAllowed,
  isProviderSandboxNotFoundError,
  RemoteSandboxSessionBase,
  type RemoteSandboxCommandOptions,
  type RemoteSandboxCommandResult,
} from '../../src/sandbox/shared';

type FakeRemoteSessionState = SandboxSessionState & {
  configuredExposedPorts?: number[];
  environment: Record<string, string>;
  workspacePersistence?: string;
};

class FakeRemoteSession extends RemoteSandboxSessionBase<FakeRemoteSessionState> {
  readonly files = new Map<string, Uint8Array>();
  readonly dirs = new Set<string>();
  readonly commands: Array<{
    command: string;
    options: RemoteSandboxCommandOptions;
  }> = [];

  constructor() {
    super({
      state: {
        manifest: new Manifest({ root: '/workspace' }),
        environment: {},
        configuredExposedPorts: [8080],
      },
      options: {
        providerName: 'FakeSandboxClient',
        providerId: 'fake',
      },
    });
  }

  protected override async runRemoteCommand(
    command: string,
    options: RemoteSandboxCommandOptions,
  ): Promise<RemoteSandboxCommandResult> {
    this.commands.push({ command, options });
    if (command === 'true') {
      return { status: 0 };
    }
    if (command.startsWith('test -e ')) {
      const path = command.slice('test -e '.length).replace(/^'|'$/g, '');
      return {
        status: this.files.has(path) || this.dirs.has(path) ? 0 : 1,
      };
    }
    return {
      status: 0,
      stdout: `ran ${command}`,
      stderr: 'warning',
    };
  }

  protected override async mkdirRemote(path: string): Promise<void> {
    this.dirs.add(path);
  }

  protected override async readRemoteText(path: string): Promise<string> {
    return new TextDecoder().decode(await this.readRemoteFile(path));
  }

  protected override async readRemoteFile(path: string): Promise<Uint8Array> {
    const content = this.files.get(path);
    if (!content) {
      throw new Error(`missing ${path}`);
    }
    return content;
  }

  protected override async writeRemoteFile(
    path: string,
    content: string | Uint8Array,
  ): Promise<void> {
    this.files.set(
      path,
      typeof content === 'string'
        ? new TextEncoder().encode(content)
        : Uint8Array.from(content),
    );
  }

  protected override async deleteRemotePath(path: string): Promise<void> {
    this.files.delete(path);
  }

  protected override async resolveRemotePath(path?: string): Promise<string> {
    return this.resolveAbsolutePath(path);
  }

  protected override assertFilesystemRunAs(_runAs?: string): void {}

  protected override exposedPortSource(): string {
    return 'fake endpoint';
  }

  protected override async resolveRemoteExposedPort(
    port: number,
  ): Promise<string> {
    return `https://sandbox.example.com:${port}`;
  }
}

describe('shared sandbox session helpers', () => {
  test('rejects unsupported core create options for provider clients', () => {
    expect(() =>
      assertCoreSnapshotUnsupported('ProviderSandboxClient', { type: 'noop' }),
    ).not.toThrow();
    expect(() =>
      assertCoreConcurrencyLimitsUnsupported('ProviderSandboxClient', {}),
    ).not.toThrow();

    expect(() =>
      assertCoreSnapshotUnsupported('ProviderSandboxClient', {
        type: 'remote',
      }),
    ).toThrow(SandboxUnsupportedFeatureError);
    expect(() =>
      assertCoreConcurrencyLimitsUnsupported('ProviderSandboxClient', {
        manifestEntries: 2,
      }),
    ).toThrow(SandboxUnsupportedFeatureError);
  });

  test('detects not-found provider errors from status fields and responses', () => {
    expect(isProviderSandboxNotFoundError({ status: 404 })).toBe(true);
    expect(isProviderSandboxNotFoundError({ statusCode: '404' })).toBe(true);
    expect(isProviderSandboxNotFoundError({ httpStatus: 404 })).toBe(true);
    expect(isProviderSandboxNotFoundError({ httpStatusCode: '404' })).toBe(
      true,
    );
    expect(
      isProviderSandboxNotFoundError({
        response: {
          status: 404,
        },
      }),
    ).toBe(true);
  });

  test('detects not-found provider errors from codes, messages, and causes', () => {
    expect(isProviderSandboxNotFoundError({ code: 404 })).toBe(true);
    expect(isProviderSandboxNotFoundError({ code: 'not_found' })).toBe(true);
    expect(isProviderSandboxNotFoundError({ code: 'resource-not-found' })).toBe(
      true,
    );
    expect(isProviderSandboxNotFoundError(new Error('404'))).toBe(true);
    expect(isProviderSandboxNotFoundError(new Error('not found'))).toBe(true);
    expect(
      isProviderSandboxNotFoundError(
        new Error('sandbox instance does not exist'),
      ),
    ).toBe(true);
    expect(
      isProviderSandboxNotFoundError(
        new Error('missing sandbox instance from provider'),
      ),
    ).toBe(true);
    expect(isProviderSandboxNotFoundError(new Error('devbox not found'))).toBe(
      true,
    );
    expect(
      isProviderSandboxNotFoundError({
        cause: {
          code: 'notfound',
        },
      }),
    ).toBe(true);
  });

  test('ignores unrelated provider errors and recursive causes', () => {
    const cyclic: { cause?: unknown; message: string } = {
      message: 'request timeout',
    };
    cyclic.cause = cyclic;

    expect(isProviderSandboxNotFoundError(undefined)).toBe(false);
    expect(isProviderSandboxNotFoundError('')).toBe(false);
    expect(isProviderSandboxNotFoundError(new Error('request timeout'))).toBe(
      false,
    );
    expect(isProviderSandboxNotFoundError({ code: 'timeout' })).toBe(false);
    expect(isProviderSandboxNotFoundError(cyclic)).toBe(false);
  });

  test('allows resume recreation only for not-found provider errors', () => {
    expect(() =>
      assertResumeRecreateAllowed(new Error('devbox not found'), {
        providerName: 'RunloopSandboxClient',
        provider: 'runloop',
        details: { devboxId: 'devbox_test' },
      }),
    ).not.toThrow();

    let thrown: unknown;
    try {
      assertResumeRecreateAllowed(new Error('request timeout'), {
        providerName: 'RunloopSandboxClient',
        provider: 'runloop',
        details: { devboxId: 'devbox_test' },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(SandboxProviderError);
    expect((thrown as SandboxProviderError).details).toMatchObject({
      provider: 'runloop',
      operation: 'resume',
      devboxId: 'devbox_test',
      cause: 'request timeout',
    });
  });

  test('base session handles common exec, filesystem, image, and port helpers', async () => {
    const session = new FakeRemoteSession();
    session.files.set(
      '/workspace/image.png',
      new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    );

    const execResult = await session.execCommand({
      cmd: 'echo hello',
      maxOutputTokens: 200,
    });
    expect(execResult).toContain('ran echo hello');
    expect(execResult).toContain('warning');

    expect(await session.pathExists('image.png')).toBe(true);
    expect(await session.pathExists('missing.png')).toBe(false);
    expect(await session.running()).toBe(true);

    const image = await session.viewImage({ path: 'image.png' });
    if (
      !image.image ||
      typeof image.image !== 'object' ||
      !('mediaType' in image.image)
    ) {
      throw new Error('Expected viewImage to return inline image data.');
    }
    expect(image.image.mediaType).toBe('image/png');

    const endpoint = await session.resolveExposedPort(8080);
    expect(endpoint).toMatchObject({
      host: 'sandbox.example.com',
      port: 8080,
      tls: true,
    });
  });

  test('applies manifest runAs metadata during full manifest materialization', async () => {
    const session = new FakeRemoteSession();

    await session.applyManifest(
      new Manifest({
        entries: {
          'notes.txt': file({ content: 'hello' }),
        },
      }),
      'sandbox-user',
    );

    expect(session.commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          command: expect.stringContaining('chown'),
          options: expect.objectContaining({
            kind: 'manifest',
            workdir: '/',
          }),
        }),
      ]),
    );
    const chownCommand = session.commands.find((call) =>
      call.command.includes('chown'),
    )?.command;
    expect(chownCommand).toContain('sandbox-user');
    expect(chownCommand).toContain('/workspace/notes.txt');
  });
});
