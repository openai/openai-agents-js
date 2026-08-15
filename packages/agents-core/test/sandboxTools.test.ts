import { describe, expect, it, vi } from 'vitest';
import type { ApplyPatchOperation, ApplyPatchResult, Editor } from '../src';
import { RunContext } from '../src';
import {
  filesystem,
  Manifest,
  shell,
  prepareSandboxAgent,
  SandboxAgent,
} from '../src/sandbox';
import {
  ScriptedModel,
  scriptedSandboxSession,
  type ScriptedSandboxInput,
} from '../src/testing';

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

class FakeResponsesModel extends ScriptedModel {}

class FakeChatCompletionsModel extends ScriptedModel {}

function scriptedFilesystemSession(
  viewImageSteps: readonly ScriptedSandboxInput<'viewImage'>[] = [],
) {
  const editor = new FakeEditor();
  const session = scriptedSandboxSession([
    { method: 'createEditor', result: editor },
    ...viewImageSteps,
  ]);
  return { editor, session };
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
    const session = scriptedSandboxSession([
      { method: 'execCommand', result: 'exec ok' },
    ]);
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
    expect(session.calls).toEqual([
      expect.objectContaining({
        method: 'execCommand',
        args: [
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
        ],
      }),
    ]);
    session.assertComplete();
  });

  it('adds write_stdin for PTY sessions and preserves snake_case schemas', async () => {
    const capability = shell();
    const session = scriptedSandboxSession([
      { method: 'supportsPty', result: true },
      { method: 'writeStdin', result: 'stdin ok' },
    ]);
    session.execCommand = async () => 'unused';
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
    expect(session.calls).toEqual([
      expect.objectContaining({ method: 'supportsPty', args: [] }),
      expect.objectContaining({
        method: 'writeStdin',
        args: [
          {
            sessionId: 1337,
            chars: 'hello',
            yieldTimeMs: 25,
            maxOutputTokens: 64,
          },
        ],
      }),
    ]);
    session.assertComplete();
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
    const { session } = scriptedFilesystemSession([
      {
        method: 'viewImage',
        result: {
          type: 'image',
          image: {
            data: Uint8Array.from([137, 80, 78, 71]),
            mediaType: 'image/png',
          },
        },
      },
    ]);
    capability
      .bind(session)
      .bindRunAs('sandbox-user')
      .bindModel('gpt-4.1', new FakeResponsesModel() as any);

    const tools = capability.tools();

    expect(tools.map((tool) => tool.name)).toEqual([
      'view_image',
      'apply_patch',
    ]);
    expect((tools[0] as any).description).toBe(
      'Returns an image output from a path in the sandbox workspace or an explicitly granted sandbox path.',
    );
    expect((tools[0] as any).parameters.properties.path.description).toBe(
      'Path to an image file in the sandbox workspace or an explicitly granted sandbox path',
    );
    expect(session.calls[0]).toMatchObject({
      method: 'createEditor',
      args: ['sandbox-user'],
    });

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
    expect(session.calls[1]).toMatchObject({
      method: 'viewImage',
      args: [{ path: 'images/example.png', runAs: 'sandbox-user' }],
    });
    session.assertComplete();
  });

  it('returns model-readable view_image errors', async () => {
    const capability = filesystem();
    const { session } = scriptedFilesystemSession([
      {
        method: 'viewImage',
        error: new Error('Unsupported image format for view_image: notes.txt'),
      },
    ]);
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
    expect(session.calls[1]).toMatchObject({
      method: 'viewImage',
      args: [{ path: 'notes.txt', runAs: 'sandbox-user' }],
    });
    session.assertComplete();
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
      const { session } = scriptedFilesystemSession([
        { method: 'viewImage', error: new Error(message) },
      ]);
      capability
        .bind(session)
        .bindModel('gpt-4o', new FakeChatCompletionsModel() as any);

      const [viewImage] = capability.tools();
      const result = await (viewImage as any).invoke(
        new RunContext(),
        JSON.stringify({ path: 'missing.png' }),
      );

      expect(result).toBe(expected);
      session.assertComplete();
    },
  );

  it('renders every supported view_image result for text transports', async () => {
    const capability = filesystem();
    const { session } = scriptedFilesystemSession([
      { method: 'viewImage', result: 'openai-file-reference' as any },
      {
        method: 'viewImage',
        result: {
          type: 'image',
          image: 'data:image/png;base64,a',
        },
      },
      {
        method: 'viewImage',
        result: {
          type: 'image',
          image: { url: 'https://example.com/image.png' },
        },
      },
      {
        method: 'viewImage',
        result: {
          type: 'image',
          image: { fileId: 'file_123' },
        },
      },
      {
        method: 'viewImage',
        result: {
          type: 'image',
          image: { data: 'YWJj' },
        },
      },
      {
        method: 'viewImage',
        result: {
          type: 'image',
          image: { data: Uint8Array.from([97, 98, 99]) },
        },
      },
      {
        method: 'viewImage',
        result: { type: 'image', image: null } as any,
      },
    ]);
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
    session.assertComplete();
  });

  it('requires filesystem sessions to provide editor and image handlers', async () => {
    const noEditor = filesystem().bind({
      state: { manifest: new Manifest() },
      viewImage: async () => 'image',
    } as any);
    expect(() => noEditor.tools()).toThrow(
      'Filesystem sandbox sessions must provide createEditor().',
    );

    const { session } = scriptedFilesystemSession();
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
    session.assertComplete();
  });

  it('allows callers to configure the filesystem tool set', () => {
    const capability = filesystem({
      configureTools: (tools) =>
        tools.filter((candidate) => candidate.name === 'view_image'),
    });
    const { session } = scriptedFilesystemSession();
    session.viewImage = async () => ({ type: 'image' });
    capability.bind(session);

    expect(capability.tools().map((candidate) => candidate.name)).toEqual([
      'view_image',
    ]);
    session.assertComplete();
  });

  it('exposes function fallbacks after binding to a chat-completions model', async () => {
    const capability = filesystem();
    const { editor, session } = scriptedFilesystemSession([
      {
        method: 'viewImage',
        result: {
          type: 'image',
          image: {
            data: Uint8Array.from([137, 80, 78, 71]),
            mediaType: 'image/png',
          },
        },
      },
    ]);
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
    expect((tools[0] as any).description).toBe(
      'Returns an image from a path in the sandbox workspace or an explicitly granted sandbox path as a data URL or reference string.',
    );
    expect((tools[0] as any).parameters.properties.path.description).toBe(
      'Path to an image file in the sandbox workspace or an explicitly granted sandbox path',
    );

    const imageResult = await (tools[0] as any).invoke(
      new RunContext(),
      JSON.stringify({ path: 'images/example.png' }),
    );

    expect(imageResult).toBe('data:image/png;base64,iVBORw==');
    expect(session.calls[1]).toMatchObject({
      method: 'viewImage',
      args: [{ path: 'images/example.png', runAs: 'sandbox-user' }],
    });

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
    expect(editor.calls).toEqual([
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
    session.assertComplete();
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
      const { editor, session } = scriptedFilesystemSession();
      capability
        .bind(session)
        .bindModel('gpt-4o', new FakeChatCompletionsModel() as any);
      const applyPatch = capability.tools()[1];

      await expect(
        (applyPatch as any).invoke(new RunContext(), input),
      ).resolves.toContain(error);
      expect(editor.calls).toEqual([]);
      session.assertComplete();
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
      const { editor, session } = scriptedFilesystemSession();
      capability
        .bind(session)
        .bindModel('gpt-4o', new FakeChatCompletionsModel() as any);
      const applyPatch = capability.tools()[1];

      await expect(
        (applyPatch as any).invoke(new RunContext(), input),
      ).resolves.toBe('created');
      expect(editor.calls).toEqual([
        expect.objectContaining({ type: 'create_file', path }),
      ]);
      session.assertComplete();
    },
  );

  it('returns model-readable editor failures', async () => {
    const capability = filesystem();
    const { editor, session } = scriptedFilesystemSession();
    capability
      .bind(session)
      .bindModel('gpt-4o', new FakeChatCompletionsModel() as any);
    const applyPatch = capability.tools()[1];
    const input = JSON.stringify({
      type: 'create_file',
      path: 'notes.txt',
      diff: '+hello\n',
    });
    const createFile = vi.spyOn(editor, 'createFile');

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
    session.assertComplete();
  });

  it('accepts move-only freeform apply_patch updates', async () => {
    const { editor, session } = scriptedFilesystemSession();
    session.state.manifest = new Manifest({ root: '/workspace' });
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
    expect(editor.calls).toEqual([
      {
        type: 'update_file',
        path: 'old.txt',
        diff: '',
        moveTo: 'new.txt',
      },
    ]);
    session.assertComplete();
  });
});

describe('prepareSandboxAgent tool wiring', () => {
  it('adds bound capability tools to the execution agent', () => {
    const editor = new FakeEditor();
    const session = scriptedSandboxSession([
      { method: 'createEditor', result: editor },
      { method: 'createEditor', result: editor },
      { method: 'supportsPty', result: true },
    ]);
    session.execCommand = async () => 'unused';
    session.writeStdin = async () => 'unused';
    session.viewImage = async () => ({ type: 'image' });
    session.state.manifest = new Manifest({ root: '/workspace' });
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
    session.assertComplete();
  });
});
