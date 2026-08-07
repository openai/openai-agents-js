import { describe, expect, it, vi } from 'vitest';
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
  ): Promise<ApplyPatchResult | void> {
    this.calls.push(operation);
    return { output: 'created' };
  }

  async updateFile(
    operation: Extract<ApplyPatchOperation, { type: 'update_file' }>,
  ): Promise<ApplyPatchResult | void> {
    this.calls.push(operation);
    return { output: 'updated' };
  }

  async deleteFile(
    operation: Extract<ApplyPatchOperation, { type: 'delete_file' }>,
  ): Promise<ApplyPatchResult | void> {
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

  it.each([
    ['Image not found: missing.png', 'image path `missing.png` was not found'],
    ['Path is not a file', 'image path `missing.png` is not a file'],
    [
      'Image exceeds the 10 MB limit',
      'image path `missing.png` exceeded the allowed size of 10MB; resize or compress the image and try again',
    ],
    ['permission denied', 'unable to read image at `missing.png`: Error'],
  ])(
    'classifies view_image failures for model consumption: %s',
    async (message, expected) => {
      const capability = filesystem();
      const session = new FailingViewImageSandboxSession(new Error(message));
      capability
        .bind(session)
        .bindModel('gpt-4o', new FakeChatCompletionsModel() as any);

      const [viewImage] = capability.tools();
      const result = await (viewImage as any).invoke(
        new RunContext(),
        JSON.stringify({ path: 'missing.png' }),
      );

      expect(result).toBe(expected);
    },
  );

  it('renders every supported view_image result for text transports', async () => {
    const capability = filesystem();
    const session = new FakeSandboxSession();
    const viewImage = vi.spyOn(session, 'viewImage') as any;
    viewImage
      .mockResolvedValueOnce('openai-file-reference')
      .mockResolvedValueOnce({
        type: 'image',
        image: 'data:image/png;base64,a',
      })
      .mockResolvedValueOnce({
        type: 'image',
        image: { url: 'https://example.com/image.png' },
      })
      .mockResolvedValueOnce({
        type: 'image',
        image: { fileId: 'file_123' },
      })
      .mockResolvedValueOnce({
        type: 'image',
        image: { data: 'YWJj' },
      })
      .mockResolvedValueOnce({
        type: 'image',
        image: { data: Uint8Array.from([97, 98, 99]) },
      })
      .mockResolvedValueOnce({ type: 'image', image: null });
    capability
      .bind(session)
      .bindModel('gpt-4o', new FakeChatCompletionsModel() as any);

    const [viewImageTool] = capability.tools();
    const invoke = () =>
      (viewImageTool as any).invoke(
        new RunContext(),
        JSON.stringify({ path: 'image.png' }),
      );

    await expect(invoke()).resolves.toBe('openai-file-reference');
    await expect(invoke()).resolves.toBe('data:image/png;base64,a');
    await expect(invoke()).resolves.toBe('https://example.com/image.png');
    await expect(invoke()).resolves.toBe('OpenAI file reference: file_123');
    await expect(invoke()).resolves.toBe(
      'data:application/octet-stream;base64,YWJj',
    );
    await expect(invoke()).resolves.toBe(
      'data:application/octet-stream;base64,YWJj',
    );
    await expect(invoke()).resolves.toBe(
      'No image data was returned by the sandbox session.',
    );
  });

  it('requires filesystem sessions to provide editor and image handlers', async () => {
    const noEditor = filesystem().bind({
      state: { manifest: new Manifest() },
      viewImage: async () => 'image',
    } as any);
    expect(() => noEditor.tools()).toThrow(
      'Filesystem sandbox sessions must provide createEditor().',
    );

    const session = new FakeSandboxSession();
    (session as any).viewImage = undefined;
    const noViewImage = filesystem();
    noViewImage
      .bind(session)
      .bindModel('gpt-4o', new FakeChatCompletionsModel() as any);
    const [viewImageTool] = noViewImage.tools();

    await expect(
      (viewImageTool as any).invoke(
        new RunContext(),
        JSON.stringify({ path: 'image.png' }),
      ),
    ).resolves.toContain(
      'Filesystem sandbox sessions must provide viewImage().',
    );
  });

  it('allows callers to configure the filesystem tool set', () => {
    const capability = filesystem({
      configureTools: (tools) =>
        tools.filter((candidate) => candidate.name === 'view_image'),
    });
    capability.bind(new FakeSandboxSession());

    expect(capability.tools().map((candidate) => candidate.name)).toEqual([
      'view_image',
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

  it.each([
    ['not-json', 'Invalid apply_patch JSON:'],
    [JSON.stringify(null), 'apply_patch input must be an object or array.'],
    [JSON.stringify([]), 'apply_patch input must include an operation.'],
    [
      ['*** Begin Patch', '*** Add File: notes.txt', '*** End Patch'].join(
        '\n',
      ),
      'Add File patch for notes.txt must include at least one + line.',
    ],
    [
      [
        '*** Begin Patch',
        '*** Add File: notes.txt',
        'plain',
        '*** End Patch',
      ].join('\n'),
      'Invalid Add File line: plain',
    ],
    [
      [
        '*** Begin Patch',
        '*** Delete File: notes.txt',
        '+unexpected',
        '*** End Patch',
      ].join('\n'),
      'Delete File patch for notes.txt must not include a diff.',
    ],
    [
      ['*** Begin Patch', '*** Update File: notes.txt', '*** End Patch'].join(
        '\n',
      ),
      'Update File patch for notes.txt must include a hunk.',
    ],
    [
      ['*** Begin Patch', '*** Unknown File: notes.txt', '*** End Patch'].join(
        '\n',
      ),
      'Invalid apply_patch file operation header: *** Unknown File: notes.txt',
    ],
    [
      ['*** Begin Patch', '*** Add File: notes.txt', '+hello'].join('\n'),
      'apply_patch input must end with "*** End Patch".',
    ],
  ])(
    'returns model-readable apply_patch input errors',
    async (input, error) => {
      const capability = filesystem();
      const session = new FakeSandboxSession();
      capability
        .bind(session)
        .bindModel('gpt-4o', new FakeChatCompletionsModel() as any);
      const applyPatch = capability.tools()[1];

      await expect(
        (applyPatch as any).invoke(new RunContext(), input),
      ).resolves.toContain(error);
      expect(session.editor.calls).toEqual([]);
    },
  );

  it.each([
    [
      JSON.stringify([
        { type: 'create_file', path: 'array.txt', diff: '+array\n' },
      ]),
      'array.txt',
    ],
    [
      JSON.stringify({
        operation: {
          type: 'create_file',
          path: 'operation.txt',
          diff: '+operation\n',
        },
      }),
      'operation.txt',
    ],
    [
      JSON.stringify({
        operations: [
          {
            type: 'create_file',
            path: 'operations.txt',
            diff: '+operations\n',
          },
        ],
      }),
      'operations.txt',
    ],
    [
      JSON.stringify({
        command: [
          'apply_patch',
          [
            '*** Begin Patch',
            '*** Add File: command.txt',
            '+command',
            '*** End Patch',
          ].join('\n'),
        ],
      }),
      'command.txt',
    ],
  ])(
    'accepts supported structured apply_patch input forms',
    async (input, path) => {
      const capability = filesystem();
      const session = new FakeSandboxSession();
      capability
        .bind(session)
        .bindModel('gpt-4o', new FakeChatCompletionsModel() as any);
      const applyPatch = capability.tools()[1];

      await expect(
        (applyPatch as any).invoke(new RunContext(), input),
      ).resolves.toBe('created');
      expect(session.editor.calls).toEqual([
        expect.objectContaining({ type: 'create_file', path }),
      ]);
    },
  );

  it('returns model-readable editor failures', async () => {
    const capability = filesystem();
    const session = new FakeSandboxSession();
    capability
      .bind(session)
      .bindModel('gpt-4o', new FakeChatCompletionsModel() as any);
    const applyPatch = capability.tools()[1];
    const input = JSON.stringify({
      type: 'create_file',
      path: 'notes.txt',
      diff: '+hello\n',
    });
    const createFile = vi.spyOn(session.editor, 'createFile');

    createFile.mockRejectedValueOnce(new Error('permission denied'));
    await expect(
      (applyPatch as any).invoke(new RunContext(), input),
    ).resolves.toBe('Failed to apply patch: permission denied');

    createFile.mockResolvedValueOnce({
      status: 'failed',
      output: 'workspace is read-only',
    });
    await expect(
      (applyPatch as any).invoke(new RunContext(), input),
    ).resolves.toBe('Patch failed: workspace is read-only');

    createFile.mockResolvedValueOnce({ status: 'failed' });
    await expect(
      (applyPatch as any).invoke(new RunContext(), input),
    ).resolves.toBe('Patch failed.');

    createFile.mockResolvedValueOnce(undefined);
    await expect(
      (applyPatch as any).invoke(new RunContext(), input),
    ).resolves.toBe('Patch applied.');
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
