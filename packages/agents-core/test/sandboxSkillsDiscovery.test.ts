import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  skills,
  Manifest,
  prepareSandboxAgent,
  SandboxAgent,
} from '../src/sandbox';
import { localDirLazySkillSource } from '../src/sandbox/local';
import { scriptedSandboxSession } from '../src/testing';
import { RunContext } from '../src/runContext';

describe('Skills discovery', () => {
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

  it('renders a large literal description from lazy discovery', async () => {
    const description = `First line\n${'Detail\n'.repeat(1_000_000)}Last line`;
    const markdown = `---\nname: large-skill\ndescription: |\n  ${description.split('\n').join('\n  ')}\n---\n`;
    await expectDiscoveredSkillIndex(
      'lazy',
      markdown,
      'large-skill',
      description,
    );
  });

  it('renders a large discovered literal description in prepared-agent instructions', async () => {
    const description = `First line\n${'Detail\n'.repeat(1_000_000)}Last line`;
    const markdown = `---\nname: large-skill\ndescription: |\n  ${description.split('\n').join('\n  ')}\n---\n`;
    const capability = skills({ from: { type: 'dir', children: {} } });
    const session = scriptedSandboxSession([
      {
        method: 'listDir',
        result: [{ name: 'review', path: '.agents/review', type: 'dir' }],
      },
      { method: 'readFile', result: markdown },
    ]);
    const instructions = await prepareSandboxAgent({
      agent: new SandboxAgent({ name: 'skills', baseInstructions: 'Base' }),
      session: { ...session, state: { manifest: new Manifest() } },
      capabilities: [capability],
    }).getSystemPrompt(new RunContext());

    expect(instructions).toContain(
      `- large-skill: ${description} (file: .agents/review)`,
    );
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
