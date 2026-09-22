import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  skills,
  type Entry,
  Manifest,
  SandboxSkillsConfigError,
  SandboxWorkspaceReadNotFoundError,
} from '../src/sandbox';
import { localDirLazySkillSource } from '../src/sandbox/local';
import { scriptedSandboxSession } from '../src/testing';

describe('Skills', () => {
  describe.each(['lazy', 'runtime'] as const)(
    '%s frontmatter discovery',
    (mode) => {
      it.each([
        {
          label: 'wrapped plain description',
          frontmatter: 'description: Review issues\n  and suggest next steps.',
          description: 'Review issues and suggest next steps.',
        },
        {
          label: 'folded description',
          frontmatter:
            'description: >\n  Review issues.\n  Suggest next steps.',
          description: 'Review issues. Suggest next steps.',
        },
        {
          label: 'literal description',
          frontmatter:
            'description: |\n  Review issues.\n  Suggest next steps.',
          description: 'Review issues.\nSuggest next steps.',
        },
        {
          label: 'plain paragraphs and comments',
          frontmatter:
            'description: First paragraph.\n  # ignored\n\n  Second paragraph.\n  Continued.',
          description: 'First paragraph.\nSecond paragraph. Continued.',
        },
        {
          label: 'folded paragraphs and more-indented lines',
          frontmatter:
            'description: >\n  First paragraph.\n\n  Second paragraph.\n\n    code one\n    code two\n\n  Last paragraph.',
          description:
            'First paragraph.\nSecond paragraph.\n\n  code one\n  code two\n\nLast paragraph.',
        },
        {
          label: 'literal indentation, hashes, quotes and escapes',
          frontmatter:
            'description: |\n  "quoted"\n    indented\n\n  # content\n  \\n is literal',
          description: '"quoted"\n  indented\n\n# content\n\\n is literal',
        },
        {
          label: 'folded document marker',
          frontmatter: 'description: >\n  First\n  ---\n  last',
          description: 'First --- last',
        },
        {
          label: 'literal document marker and key-shaped content',
          frontmatter:
            'description: |\n  First\n  ---\n  name: content\n  description: content',
          description: 'First\n---\nname: content\ndescription: content',
        },
        {
          label: 'folded header indicators and comment',
          frontmatter: 'description: >2- # comment +9\n    first\n  last\n\n',
          description: 'first\nlast',
        },
        {
          label: 'literal header indicators and comment',
          frontmatter: 'description: |+2 # comment\n  first\n    last\n\n',
          description: 'first\n  last',
        },
        {
          label: 'header comments without indentation indicators',
          frontmatter:
            'description: > # comment 9+\n  first\n  last\n # trailing metadata comment',
          description: 'first last',
        },
        {
          label: 'empty block before a dedented comment',
          frontmatter:
            'description: >2\n # metadata comment\n  # another comment',
          description: '',
        },
        {
          label: 'single-line quoted whitespace',
          frontmatter: 'description: "  Keep spaces  "\n\n  # ignored',
          description: '  Keep spaces  ',
        },
        {
          label: 'single-line inline hash',
          frontmatter: "description: 'Review' # keep hash text",
          description: "'Review' # keep hash text",
        },
        {
          label: 'opaque tag text',
          frontmatter: 'description: !custom text',
          description: '!custom text',
        },
        {
          label: 'unresolved alias',
          frontmatter:
            'metadata: &details\n  description: nested\ndescription: *details',
          description: '*details',
        },
        {
          label: 'opaque collection text',
          frontmatter: 'description: [review, triage]',
          description: '[review, triage]',
        },
        {
          label: 'unsupported multiline quoted semantics',
          frontmatter: 'description: "first\n  last"',
          description: '"first',
        },
      ])(
        'renders $label in the skill index',
        async ({ frontmatter, description }) => {
          // Put the name after the scalar to verify that parsing resumes at the next field.
          const markdown = `---\n${frontmatter}\nname: issue-review\n---\n# Body\nname: body-only\n`;
          await expectDiscoveredSkillIndex(
            mode,
            markdown,
            'issue-review',
            description,
          );
        },
      );

      it.each([
        {
          label: 'nested mapping after root metadata',
          frontmatter:
            'name: issue-review\ndescription: Review issues.\nmetadata:\n  name: nested\n  description: nested',
          name: 'issue-review',
          description: 'Review issues.',
        },
        {
          label: 'nested sequence before root metadata',
          frontmatter:
            'metadata:\n  - name: nested\n    description: nested\nname: issue-review\ndescription: Review issues.',
          name: 'issue-review',
          description: 'Review issues.',
        },
        {
          label: 'only nested metadata',
          frontmatter: 'metadata:\n  name: nested\n  description: nested',
          name: 'review',
          description: 'No description provided.',
        },
        {
          label: 'consistently indented root fields',
          frontmatter:
            '  name: issue-review\n  description: >2\n    Review issues.\n    Keep café and 🐍.',
          name: 'issue-review',
          description: 'Review issues. Keep café and 🐍.',
        },
      ])(
        'keeps $label at the correct level',
        async ({ frontmatter, name, description }) => {
          const markdown = `---\n${frontmatter}\n---\n# Body\n`;
          await expectDiscoveredSkillIndex(mode, markdown, name, description);
        },
      );

      it.each([
        '# No frontmatter\n',
        '---\nname: unfinished\n',
        '\n---\nname: not-frontmatter\n---\n',
      ])('keeps fallback metadata for %j', async (markdown) => {
        await expectDiscoveredSkillIndex(
          mode,
          markdown,
          'review',
          'No description provided.',
        );
      });

      it('reads CRLF frontmatter', async () => {
        await expectDiscoveredSkillIndex(
          mode,
          '---\r\nname: issue-review\r\ndescription: >\r\n  First\r\n  last\r\n---\r\n',
          'issue-review',
          'First last',
        );
      });
    },
  );

  it('requires exactly one source', () => {
    expect(() => skills({})).toThrow(SandboxSkillsConfigError);
    expect(() => skills({})).toThrow(
      'skills capability requires `skills`, `from`, or `lazyFrom`.',
    );

    expect(() =>
      skills({
        skills: [
          {
            name: 'my-skill',
            description: 'desc',
            content: 'literal',
          },
        ],
        from: {
          type: 'dir',
          children: {},
        },
      }),
    ).toThrow(
      'skills capability accepts only one of `skills`, `from`, or `lazyFrom`.',
    );
  });

  it('materializes explicit skill descriptors into the manifest', () => {
    const capability = skills({
      skills: [
        {
          name: 'my-skill',
          description: 'desc',
          content: 'Use this skill.',
          scripts: {
            'run.sh': {
              type: 'file',
              content: 'echo run\n',
            },
          },
          references: {
            'docs/readme.md': {
              type: 'file',
              content: 'reference\n',
            },
          },
          assets: {
            'images/icon.txt': {
              type: 'file',
              content: 'asset\n',
            },
          },
        },
      ],
    });

    const manifest = capability.processManifest(new Manifest());
    const entry = manifest.entries['.agents/my-skill'] as Extract<
      Entry,
      { type: 'dir' }
    >;

    expect(entry.type).toBe('dir');
    expect(entry.children).toMatchObject({
      'SKILL.md': {
        type: 'file',
        content: 'Use this skill.',
      },
      scripts: {
        type: 'dir',
      },
      references: {
        type: 'dir',
      },
      assets: {
        type: 'dir',
      },
    });
  });

  it('renders instructions for explicit skills', async () => {
    const capability = skills({
      skills: [
        {
          name: 'z-skill',
          description: 'z description',
          content: 'z',
        },
        {
          name: 'a-skill',
          description: 'a description',
          content: 'a',
        },
      ],
    });

    const instructions = await capability.instructions(new Manifest());

    expect(instructions).toContain('## Skills');
    expect(instructions).toContain(
      '- a-skill: a description (file: .agents/a-skill)',
    );
    expect(instructions).toContain(
      '- z-skill: z description (file: .agents/z-skill)',
    );
    expect(instructions!.indexOf('- a-skill: a description')).toBeLessThan(
      instructions!.indexOf('- z-skill: z description'),
    );
  });

  it('derives instructions for bundled skill directories without a manual index', async () => {
    const capability = skills({
      from: {
        type: 'dir',
        children: {
          'z-skill': {
            type: 'dir',
            description: 'z description',
            children: {
              'SKILL.md': {
                type: 'file',
                content: 'z',
              },
            },
          },
          'a-skill': {
            type: 'dir',
            description: 'a description',
            children: {
              'SKILL.md': {
                type: 'file',
                content: 'a',
              },
            },
          },
        },
      },
    });

    const instructions = await capability.instructions(new Manifest());

    expect(instructions).toContain(
      '- a-skill: a description (file: .agents/a-skill)',
    );
    expect(instructions).toContain(
      '- z-skill: z description (file: .agents/z-skill)',
    );
    expect(instructions!.indexOf('- a-skill: a description')).toBeLessThan(
      instructions!.indexOf('- z-skill: z description'),
    );
  });

  it('accepts GitRepo sources and renders runtime discovery guidance', async () => {
    const capability = skills({
      from: {
        type: 'git_repo',
        repo: 'openai/skills',
        ref: 'main',
      },
    });
    const manifest = capability.processManifest(new Manifest());
    const instructions = await capability.instructions(manifest);

    expect(manifest.entries['.agents']).toMatchObject({
      type: 'git_repo',
      repo: 'openai/skills',
    });
    expect(instructions).toContain('Skills are materialized under .agents');
  });

  it('validates lazy path overlap against the manifest', () => {
    const capability = skills({
      lazyFrom: {
        source: {
          type: 'local_dir',
          src: 'skills',
        },
        index: [
          {
            name: 'dynamic-skill',
            description: 'dynamic',
          },
        ],
      },
    });

    expect(() =>
      capability.processManifest(
        new Manifest({
          entries: {
            '.agents': {
              type: 'dir',
              children: {},
            },
          },
        }),
      ),
    ).toThrow(
      'skills lazyFrom path overlaps existing manifest entries: .agents',
    );
  });

  it('exposes load_skill for lazy sources and materializes one skill at a time', async () => {
    const capability = skills({
      lazyFrom: {
        source: {
          type: 'local_dir',
          src: 'skills',
        },
        index: [
          {
            name: 'dynamic-skill',
            description: 'dynamic',
          },
        ],
      },
    });
    const session = scriptedSandboxSession([
      { method: 'pathExists', result: false },
      { method: 'materializeEntry', result: undefined },
      { method: 'pathExists', result: true },
    ]);
    capability.bind(session);

    const tools = capability.tools();

    expect(tools.map((tool) => tool.name)).toEqual(['load_skill']);

    const first = await (tools[0] as any).invoke(
      undefined,
      JSON.stringify({ skill_name: 'dynamic-skill' }),
    );
    const second = await (tools[0] as any).invoke(
      undefined,
      JSON.stringify({ skill_name: 'dynamic-skill' }),
    );

    expect(first).toEqual({
      status: 'loaded',
      skill_name: 'dynamic-skill',
      path: '.agents/dynamic-skill',
    });
    expect(second).toEqual({
      status: 'already_loaded',
      skill_name: 'dynamic-skill',
      path: '.agents/dynamic-skill',
    });
    expect(session.calls[1]).toMatchObject({
      method: 'materializeEntry',
      args: [
        {
          path: '.agents/dynamic-skill',
          entry: {
            type: 'local_dir',
            src: 'skills/dynamic-skill',
          },
          runAs: undefined,
        },
      ],
    });
    session.assertComplete();
  });

  it('discovers lazy local directory skill metadata from SKILL.md frontmatter', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agents-skills-'));
    try {
      const skillsRoot = join(root, 'skills');
      const skillDir = join(skillsRoot, 'sheet-tools');
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(
        join(skillDir, 'SKILL.md'),
        [
          '---',
          'name: "spreadsheet-review"',
          "description: 'Review spreadsheets quickly'",
          '---',
          '# Spreadsheet review',
        ].join('\n'),
        'utf8',
      );

      const capability = skills({
        lazyFrom: localDirLazySkillSource(skillsRoot),
      });
      const manifest = new Manifest({
        extraPathGrants: [{ path: skillsRoot, readOnly: true }],
      });
      const instructions = await capability.instructions(manifest);

      expect(instructions).toContain(
        '- spreadsheet-review: Review spreadsheets quickly (file: .agents/sheet-tools)',
      );

      const session = scriptedSandboxSession([
        { method: 'pathExists', result: false },
        { method: 'materializeEntry', result: undefined },
      ]);
      session.state.manifest = manifest;
      capability.bind(session);
      const [tool] = capability.tools();

      const result = await (tool as any).invoke(
        undefined,
        JSON.stringify({ skill_name: 'spreadsheet-review' }),
      );

      expect(result).toEqual({
        status: 'loaded',
        skill_name: 'spreadsheet-review',
        path: '.agents/sheet-tools',
      });
      expect(session.calls[1]).toMatchObject({
        method: 'materializeEntry',
        args: [
          {
            path: '.agents/sheet-tools',
            entry: {
              type: 'local_dir',
              src: `${skillsRoot}/sheet-tools`,
            },
            runAs: undefined,
          },
        ],
      });
      session.assertComplete();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not discover lazy local directory metadata outside the base directory without a grant', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agents-skills-outside-'));
    try {
      const skillsRoot = join(root, 'skills');
      const skillDir = join(skillsRoot, 'hidden-skill');
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(
        join(skillDir, 'SKILL.md'),
        [
          '---',
          'name: hidden-skill',
          'description: Outside the base directory',
          '---',
          '# Hidden skill',
        ].join('\n'),
        'utf8',
      );

      const capability = skills({
        lazyFrom: localDirLazySkillSource(skillsRoot),
      });
      const instructions = await capability.instructions(new Manifest());

      expect(instructions).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('discovers lazy local directory metadata outside the base directory with a grant', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agents-skills-granted-'));
    try {
      const skillsRoot = join(root, 'skills');
      const skillDir = join(skillsRoot, 'hidden-skill');
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(
        join(skillDir, 'SKILL.md'),
        [
          '---',
          'name: hidden-skill',
          'description: Outside the base directory',
          '---',
          '# Hidden skill',
        ].join('\n'),
        'utf8',
      );

      const capability = skills({
        lazyFrom: localDirLazySkillSource(skillsRoot),
      });
      const instructions = await capability.instructions(
        new Manifest({
          extraPathGrants: [{ path: skillsRoot, readOnly: true }],
        }),
      );

      expect(instructions).toContain(
        '- hidden-skill: Outside the base directory (file: .agents/hidden-skill)',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not discover lazy local directory metadata through a symlinked source', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agents-skills-symlink-'));
    try {
      const base = join(root, 'base');
      const outsideSkillsRoot = join(root, 'outside-skills');
      const outsideSkillDir = join(outsideSkillsRoot, 'hidden-skill');
      mkdirSync(base);
      mkdirSync(outsideSkillDir, { recursive: true });
      writeFileSync(
        join(outsideSkillDir, 'SKILL.md'),
        [
          '---',
          'name: hidden-skill',
          'description: Outside the base directory',
          '---',
          '# Hidden skill',
        ].join('\n'),
        'utf8',
      );
      symlinkSync(outsideSkillsRoot, join(base, 'skills'), 'dir');

      const capability = skills({
        lazyFrom: localDirLazySkillSource({
          src: 'skills',
          baseDir: base,
        }),
      });
      const instructions = await capability.instructions(new Manifest());

      expect(instructions).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not discover lazy local directory metadata through a symlinked SKILL.md', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agents-skills-file-symlink-'));
    try {
      const base = join(root, 'base');
      const skillDir = join(base, 'skills', 'hidden-skill');
      const outside = join(root, 'outside');
      mkdirSync(skillDir, { recursive: true });
      mkdirSync(outside);
      writeFileSync(
        join(outside, 'SKILL.md'),
        [
          '---',
          'name: hidden-skill',
          'description: Outside the base directory',
          '---',
          '# Hidden skill',
        ].join('\n'),
        'utf8',
      );
      symlinkSync(join(outside, 'SKILL.md'), join(skillDir, 'SKILL.md'));

      const capability = skills({
        lazyFrom: localDirLazySkillSource({
          src: 'skills',
          baseDir: base,
        }),
      });
      const instructions = await capability.instructions(new Manifest());

      expect(instructions).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('resolves lazy local directory skill sources against baseDir', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agents-skills-base-'));
    try {
      const skillDir = join(root, 'skills', 'relative-skill');
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(
        join(skillDir, 'SKILL.md'),
        [
          '---',
          'name: relative-skill',
          'description: Uses a relative baseDir source',
          '---',
          '# Relative skill',
        ].join('\n'),
        'utf8',
      );

      const capability = skills({
        lazyFrom: localDirLazySkillSource({
          src: 'skills',
          baseDir: root,
        }),
      });
      const session = scriptedSandboxSession([
        { method: 'pathExists', result: false },
        { method: 'materializeEntry', result: undefined },
      ]);
      capability.bind(session);
      const [tool] = capability.tools();

      const result = await (tool as any).invoke(
        undefined,
        JSON.stringify({ skill_name: 'relative-skill' }),
      );

      expect(result).toMatchObject({
        status: 'loaded',
        skill_name: 'relative-skill',
        path: '.agents/relative-skill',
      });
      expect(session.calls[1]).toMatchObject({
        method: 'materializeEntry',
        args: [
          {
            path: '.agents/relative-skill',
            entry: {
              type: 'local_dir',
              src: `${root}/skills/relative-skill`,
            },
            runAs: undefined,
          },
        ],
      });
      session.assertComplete();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reads materialized from skill metadata from the bound session', async () => {
    const capability = skills({
      from: {
        type: 'dir',
        children: {},
      },
    });
    const session = scriptedSandboxSession([
      {
        method: 'listDir',
        result: [
          {
            name: 'sheet-tools',
            path: '.agents/sheet-tools',
            type: 'dir',
          },
        ],
      },
      {
        method: 'readFile',
        result: [
          '---',
          'name: "spreadsheet-review"',
          "description: 'Review spreadsheets quickly'",
          '---',
          '# Spreadsheet review',
        ].join('\n'),
      },
    ]);
    capability.bind(session);

    const instructions = await capability.instructions(new Manifest());

    expect(instructions).toContain(
      '- spreadsheet-review: Review spreadsheets quickly (file: .agents/sheet-tools)',
    );
    session.assertComplete();
  });

  it('ignores missing skill directories while preserving access failures', async () => {
    const capability = skills({ from: { type: 'dir', children: {} } });
    const denied = Object.assign(new Error('Permission denied'), {
      code: 'EACCES',
    });
    const session = scriptedSandboxSession([
      {
        method: 'listDir',
        error: new SandboxWorkspaceReadNotFoundError('missing skill directory'),
      },
      { method: 'listDir', error: denied },
    ]);
    session.readFile = async () => 'unused';
    capability.bind(session);

    await expect(capability.instructions(new Manifest())).resolves.toContain(
      '.agents',
    );

    await expect(capability.instructions(new Manifest())).rejects.toBe(denied);
    session.assertComplete();
  });

  it('skips missing skill files without suppressing unreadable files', async () => {
    const capability = skills({ from: { type: 'dir', children: {} } });
    const denied = Object.assign(new Error('Permission denied'), {
      code: 'EACCES',
    });
    const directory = {
      name: 'blocked',
      path: '.agents/blocked',
      type: 'dir' as const,
    };
    const session = scriptedSandboxSession([
      { method: 'listDir', result: [directory] },
      {
        method: 'readFile',
        error: new SandboxWorkspaceReadNotFoundError('missing skill file'),
      },
      { method: 'listDir', result: [directory] },
      { method: 'readFile', error: denied },
    ]);
    capability.bind(session);

    await expect(capability.instructions(new Manifest())).resolves.toContain(
      '.agents',
    );

    await expect(capability.instructions(new Manifest())).rejects.toBe(denied);
    session.assertComplete();
  });

  it('does not materialize lazy skills when their existence cannot be determined', async () => {
    const capability = skills({
      lazyFrom: {
        source: { type: 'local_dir', src: 'skills' },
        index: [{ name: 'dynamic-skill', description: 'dynamic' }],
      },
    });
    const denied = Object.assign(new Error('Permission denied'), {
      code: 'EACCES',
    });
    const session = scriptedSandboxSession([
      { method: 'pathExists', error: denied },
    ]);
    session.materializeEntry = async () => {
      throw new Error('materializeEntry must not be called');
    };
    capability.bind(session);

    await expect(
      (capability.tools()[0] as any).invoke(
        undefined,
        JSON.stringify({ skill_name: 'dynamic-skill' }),
      ),
    ).resolves.toBe(
      'An error occurred while running the tool. Please try again.',
    );
    expect(session.calls.map((call) => call.method)).toEqual(['pathExists']);
    session.assertComplete();
  });

  it('renders lazy loading guidance for lazy skill sources', async () => {
    const capability = skills({
      lazyFrom: {
        source: {
          type: 'local_dir',
          src: 'skills',
        },
        index: [
          {
            name: 'dynamic-skill',
            description: 'dynamic',
          },
        ],
      },
    });

    const instructions = await capability.instructions(new Manifest());

    expect(instructions).toContain('### Lazy loading');
    expect(instructions).toContain('Call `load_skill`');
    expect(instructions).toContain(
      '- dynamic-skill: dynamic (file: .agents/dynamic-skill)',
    );
  });

  it('supports capability-level indexes for lazy sources', async () => {
    const capability = skills({
      lazyFrom: {
        source: {
          type: 'local_dir',
          src: 'skills',
        },
      },
      index: [
        {
          name: 'dynamic-skill',
          description: 'dynamic',
        },
      ],
    });
    const session = scriptedSandboxSession([
      { method: 'pathExists', result: false },
      { method: 'materializeEntry', result: undefined },
    ]);
    capability.bind(session);

    const instructions = await capability.instructions(new Manifest());
    const [tool] = capability.tools();
    const result = await (tool as any).invoke(
      undefined,
      JSON.stringify({ skill_name: 'dynamic-skill' }),
    );

    expect(instructions).toContain(
      '- dynamic-skill: dynamic (file: .agents/dynamic-skill)',
    );
    expect(result).toEqual({
      status: 'loaded',
      skill_name: 'dynamic-skill',
      path: '.agents/dynamic-skill',
    });
    session.assertComplete();
  });

  it('materializes lazy skills from GitRepo subpaths', async () => {
    const capability = skills({
      lazyFrom: {
        source: {
          type: 'git_repo',
          repo: 'openai/skills',
          ref: 'main',
          subpath: 'bundled',
        },
        index: [
          {
            name: 'dynamic-skill',
            description: 'dynamic',
          },
        ],
      },
    });
    const session = scriptedSandboxSession([
      { method: 'pathExists', result: false },
      { method: 'materializeEntry', result: undefined },
    ]);
    capability.bind(session);

    const tools = capability.tools();
    await (tools[0] as any).invoke(
      undefined,
      JSON.stringify({ skill_name: 'dynamic-skill' }),
    );

    expect(session.calls[1]).toMatchObject({
      method: 'materializeEntry',
      args: [
        {
          path: '.agents/dynamic-skill',
          entry: {
            type: 'git_repo',
            repo: 'openai/skills',
            ref: 'main',
            subpath: 'bundled/dynamic-skill',
          },
          runAs: undefined,
        },
      ],
    });
    session.assertComplete();
  });
});

async function expectDiscoveredSkillIndex(
  mode: 'lazy' | 'runtime',
  markdown: string,
  name: string,
  description: string,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'agents-skill-frontmatter-'));
  try {
    const skillDir = join(root, 'review');
    mkdirSync(skillDir);
    writeFileSync(join(skillDir, 'SKILL.md'), markdown);
    const manifest = new Manifest({
      extraPathGrants: [{ path: root, readOnly: true }],
    });
    const capability =
      mode === 'lazy'
        ? skills({ lazyFrom: localDirLazySkillSource(root) })
        : skills({ from: { type: 'dir', children: {} } });
    const session = scriptedSandboxSession([
      {
        method: 'listDir',
        result: [{ name: 'review', path: '.agents/review', type: 'dir' }],
      },
      { method: 'readFile', result: markdown },
    ]);
    if (mode === 'runtime') {
      capability.bind(session);
    }

    const instructions = await capability.instructions(manifest);

    expect(instructions).toContain(
      `- ${name}: ${description} (file: .agents/review)`,
    );
    if (mode === 'runtime') {
      session.assertComplete();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
