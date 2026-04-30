import { describe, expect, it } from 'vitest';
import type { ApplyPatchOperation, ApplyPatchResult, Editor } from '../src';
import { RunContext } from '../src';
import {
  ExecCommandArgs,
  filesystem,
  Manifest,
  shell,
  prepareSandboxAgent,
  SandboxAgent,
  type SandboxSession,
  type SandboxSessionState,
  type ViewImageArgs,
  type WriteStdinArgs,
} from '../src/sandbox';

class FakeEditor implements Editor {
  readonly calls: ApplyPatchOperation[] = [];

  async createFile(
    operation: Extract<ApplyPatchOperation, { type: 'create_file' }>,
  ): Promise<ApplyPatchResult> {
    this.calls.push(operation);
    return { output: 'created' };
  }

  async updateFile(
    operation: Extract<ApplyPatchOperation, { type: 'update_file' }>,
  ): Promise<ApplyPatchResult> {
    this.calls.push(operation);
    return { output: 'updated' };
  }

  async deleteFile(
    operation: Extract<ApplyPatchOperation, { type: 'delete_file' }>,
  ): Promise<ApplyPatchResult> {
    this.calls.push(operation);
    return { output: 'deleted' };
  }
}

class FakeResponsesModel {
  async getResponse() {
    throw new Error('not used');
  }

  async *getStreamedResponse() {
    yield* [];
  }
}

class FakeChatCompletionsModel {
  async getResponse() {
    throw new Error('not used');
  }

  async *getStreamedResponse() {
    yield* [];
  }
}

type FakeSessionState = SandboxSessionState & {
  sessionId?: string;
};

class FakeSandboxSession implements SandboxSession<FakeSessionState> {
  readonly state: FakeSessionState;
  readonly editor = new FakeEditor();
  readonly createEditorCalls: Array<string | undefined> = [];
  readonly execCommandCalls: ExecCommandArgs[] = [];
  readonly writeStdinCalls: WriteStdinArgs[] = [];
  readonly viewImageCalls: ViewImageArgs[] = [];
  private readonly pty: boolean;

  constructor(args: { manifest?: Manifest; pty?: boolean } = {}) {
    this.state = {
      manifest: args.manifest ?? new Manifest(),
    };
    this.pty = args.pty ?? false;
  }

  createEditor(runAs?: string): Editor {
    this.createEditorCalls.push(runAs);
    return this.editor;
  }

  async execCommand(args: ExecCommandArgs): Promise<string> {
    this.execCommandCalls.push(args);
    return 'exec ok';
  }

  async writeStdin(args: WriteStdinArgs): Promise<string> {
    this.writeStdinCalls.push(args);
    return 'stdin ok';
  }

  async viewImage(args: ViewImageArgs) {
    this.viewImageCalls.push(args);
    return {
      type: 'image' as const,
      image: {
        data: Uint8Array.from([137, 80, 78, 71]),
        mediaType: 'image/png',
      },
    };
  }

  supportsPty(): boolean {
    return this.pty;
  }
}

class FailingViewImageSandboxSession extends FakeSandboxSession {
  constructor(private readonly error: Error) {
    super();
  }

  override async viewImage(args: ViewImageArgs): Promise<never> {
    this.viewImageCalls.push(args);
    throw this.error;
  }
}

describe('sandbox shell tools', () => {
  it('requires a bound session', () => {
    expect(() => shell().tools()).toThrowError(
      'Shell capability is not bound to a SandboxSession',
    );
  });

  it('matches the Python shell guidance', () => {
    expect(shell().instructions()).toBe(
      'When using the shell:\n' +
        '- Use `exec_command` for shell execution.\n' +
        '- If available, use `write_stdin` to interact with or poll running sessions.\n' +
        '- To interrupt a long-running process via `write_stdin`, start it with `tty=true` and send Ctrl-C (`\\u0003`).\n' +
        '- Prefer `rg` and `rg --files` for text/file discovery when available.\n' +
        '- Avoid using Python scripts just to print large file chunks.',
    );
  });

  it('exposes exec_command for non-PTY sessions and preserves snake_case schemas', async () => {
    const capability = shell();
    const session = new FakeSandboxSession();
    capability.bind(session).bindRunAs('sandbox-user');

    const tools = capability.tools();

    expect(tools.map((tool) => tool.name)).toEqual(['exec_command']);
    expect((tools[0] as any).parameters.properties).toMatchObject({
      cmd: expect.any(Object),
      workdir: expect.any(Object),
      shell: expect.any(Object),
      login: expect.any(Object),
      tty: expect.any(Object),
      yield_time_ms: expect.any(Object),
      max_output_tokens: expect.any(Object),
    });
    expect((tools[0] as any).parameters.required).toEqual([
      'cmd',
      'workdir',
      'shell',
      'login',
      'tty',
      'yield_time_ms',
      'max_output_tokens',
    ]);
    expect((tools[0] as any).parameters.properties.workdir).toMatchObject({
      anyOf: [{ type: 'string' }, { type: 'null' }],
    });
    expect(
      (tools[0] as any).parameters.properties.max_output_tokens,
    ).toMatchObject({
      anyOf: [{ type: 'number' }, { type: 'null' }],
    });

    const result = await (tools[0] as any).invoke(
      new RunContext(),
      JSON.stringify({
        cmd: 'pwd',
        workdir: 'src/project',
        shell: '/bin/bash',
        login: false,
        tty: true,
        yield_time_ms: 1500,
        max_output_tokens: 128,
      }),
    );

    expect(result).toBe('exec ok');
    expect(session.execCommandCalls).toEqual([
      {
        cmd: 'pwd',
        workdir: 'src/project',
        shell: '/bin/bash',
        login: false,
        tty: true,
        yieldTimeMs: 1500,
        maxOutputTokens: 128,
        runAs: 'sandbox-user',
      },
    ]);
  });

  it('adds write_stdin for PTY sessions and preserves snake_case schemas', async () => {
    const capability = shell();
    const session = new FakeSandboxSession({ pty: true });
    capability.bind(session);

    const tools = capability.tools();

    expect(tools.map((tool) => tool.name)).toEqual([
      'exec_command',
      'write_stdin',
    ]);
    expect((tools[1] as any).parameters.properties).toMatchObject({
      session_id: expect.any(Object),
      chars: expect.any(Object),
      yield_time_ms: expect.any(Object),
      max_output_tokens: expect.any(Object),
    });
    expect((tools[1] as any).parameters.required).toEqual([
      'session_id',
      'chars',
      'yield_time_ms',
      'max_output_tokens',
    ]);
    expect(
      (tools[1] as any).parameters.properties.max_output_tokens,
    ).toMatchObject({
      anyOf: [{ type: 'number' }, { type: 'null' }],
    });

    const result = await (tools[1] as any).invoke(
      new RunContext(),
      JSON.stringify({
        session_id: 1337,
        chars: 'hello',
        yield_time_ms: 25,
        max_output_tokens: 64,
      }),
    );

    expect(result).toBe('stdin ok');
    expect(session.writeStdinCalls).toEqual([
      {
        sessionId: 1337,
        chars: 'hello',
        yieldTimeMs: 25,
        maxOutputTokens: 64,
      },
    ]);
  });
});

describe('sandbox filesystem tools', () => {
  it('requires a bound session', () => {
    expect(() => filesystem().tools()).toThrowError(
      'Filesystem capability is not bound to a SandboxSession',
    );
  });

  it('exposes native view_image and apply_patch after binding to a responses model', async () => {
    const capability = filesystem();
    const session = new FakeSandboxSession();
    capability
      .bind(session)
      .bindRunAs('sandbox-user')
      .bindModel('gpt-4.1', new FakeResponsesModel() as any);

    const tools = capability.tools();

    expect(tools.map((tool) => tool.name)).toEqual([
      'view_image',
      'apply_patch',
    ]);
    expect(session.createEditorCalls).toEqual(['sandbox-user']);

    const result = await (tools[0] as any).invoke(
      new RunContext(),
      JSON.stringify({ path: 'images/example.png' }),
    );

    expect(result).toMatchObject({
      type: 'image',
      image: {
        data: expect.any(Uint8Array),
        mediaType: 'image/png',
      },
    });
    expect(session.viewImageCalls).toEqual([
      {
        path: 'images/example.png',
        runAs: 'sandbox-user',
      },
    ]);
  });

  it('returns model-readable view_image errors', async () => {
    const capability = filesystem();
    const session = new FailingViewImageSandboxSession(
      new Error('Unsupported image format for view_image: notes.txt'),
    );
    capability
      .bind(session)
      .bindRunAs('sandbox-user')
      .bindModel('gpt-4.1', new FakeResponsesModel() as any);

    const tools = capability.tools();
    const result = await (tools[0] as any).invoke(
      new RunContext(),
      JSON.stringify({ path: 'notes.txt' }),
    );

    expect(result).toBe('image path `notes.txt` is not a supported image file');
    expect(session.viewImageCalls).toEqual([
      {
        path: 'notes.txt',
        runAs: 'sandbox-user',
      },
    ]);
  });

  it('exposes function fallbacks after binding to a chat-completions model', async () => {
    const capability = filesystem();
    const session = new FakeSandboxSession();
    capability
      .bind(session)
      .bindRunAs('sandbox-user')
      .bindModel('gpt-4o', new FakeChatCompletionsModel() as any);

    const tools = capability.tools();

    expect(tools.map((tool) => tool.name)).toEqual([
      'view_image',
      'apply_patch',
    ]);
    expect(tools.map((tool) => tool.type)).toEqual(['function', 'function']);

    const imageResult = await (tools[0] as any).invoke(
      new RunContext(),
      JSON.stringify({ path: 'images/example.png' }),
    );

    expect(imageResult).toBe('data:image/png;base64,iVBORw==');
    expect(session.viewImageCalls).toEqual([
      {
        path: 'images/example.png',
        runAs: 'sandbox-user',
      },
    ]);

    const patch = [
      '*** Begin Patch',
      '*** Add File: created.txt',
      '+hello',
      '*** Update File: old.txt',
      '*** Move to: new.txt',
      '@@',
      '-old',
      '+new',
      '*** Delete File: obsolete.txt',
      '*** End Patch',
    ].join('\n');
    const patchResult = await (tools[1] as any).invoke(
      new RunContext(),
      JSON.stringify({ patch }),
    );

    expect(patchResult).toBe('created\nupdated\ndeleted');
    expect(session.editor.calls).toEqual([
      {
        type: 'create_file',
        path: 'created.txt',
        diff: '+hello\n',
      },
      {
        type: 'update_file',
        path: 'old.txt',
        diff: '@@\n-old\n+new\n',
        moveTo: 'new.txt',
      },
      {
        type: 'delete_file',
        path: 'obsolete.txt',
      },
    ]);
  });

  it('accepts move-only freeform apply_patch updates', async () => {
    const session = new FakeSandboxSession({
      manifest: new Manifest({ root: '/workspace' }),
      pty: true,
    });
    const capability = filesystem();
    capability.bind(session);
    const tools = capability.tools();
    const patch = [
      '*** Begin Patch',
      '*** Update File: old.txt',
      '*** Move to: new.txt',
      '*** End Patch',
    ].join('\n');

    const patchResult = await (tools[1] as any).invoke(
      new RunContext(),
      JSON.stringify({ patch }),
    );

    expect(patchResult).toBe('updated');
    expect(session.editor.calls).toEqual([
      {
        type: 'update_file',
        path: 'old.txt',
        diff: '',
        moveTo: 'new.txt',
      },
    ]);
  });
});

describe('prepareSandboxAgent tool wiring', () => {
  it('adds bound capability tools to the execution agent', () => {
    const session = new FakeSandboxSession({
      manifest: new Manifest({ root: '/workspace' }),
      pty: true,
    });
    const prepared = prepareSandboxAgent({
      agent: new SandboxAgent({
        name: 'sandbox',
        capabilities: [filesystem(), shell()],
      }),
      session,
      runConfigModel: new FakeResponsesModel() as any,
    });

    expect(prepared.tools.map((tool) => tool.name)).toEqual([
      'view_image',
      'apply_patch',
      'exec_command',
      'write_stdin',
    ]);
  });
});
