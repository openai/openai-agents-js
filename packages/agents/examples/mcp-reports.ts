import { randomUUID } from 'node:crypto';
import { Agent, NativeProvider, selectMcpTools } from '@openai/agents';
import {
  MCPServerStreamableHttp,
  type CallToolResult,
  type MCPCallToolOptions,
} from '@openai/agents/classic';

const MAX_VISIBLE_BYTES = 4096;
const MAX_REPORT_BYTES = 64 * 1024;
const MAX_STORED_BYTES = 128 * 1024;
const MAX_REPORTS = 4;

type ResolveReport = (
  result: CallToolResult,
  signal?: AbortSignal,
) => Promise<CallToolResult>;

function checkReport(result: CallToolResult): void {
  if (result.content.length > 8) {
    throw new Error(
      'This report example accepts at most eight content blocks.',
    );
  }
}

function visibleBytes(result: CallToolResult): number {
  return Buffer.byteLength(
    JSON.stringify({
      content: result.content.filter((block) => block.type === 'text'),
      structuredContent: result.structuredContent,
    }),
  );
}

/** One application owner's reports, kept only for this connection's lifetime. */
export class ReportServer extends MCPServerStreamableHttp {
  private readonly reports = new Map<string, string>();
  private storedBytes = 0;
  private closed = false;

  constructor(
    url: string,
    private readonly owner: symbol,
    private readonly resolveReport: ResolveReport,
  ) {
    // Content mode preserves media even when structuredContent is also present.
    super({ url, name: 'reports', useStructuredContent: false });
  }

  references(owner: symbol): readonly string[] {
    this.checkOwner(owner);
    return [...this.reports.keys()];
  }

  read(owner: symbol, reference: string): CallToolResult {
    this.checkOwner(owner);
    const original = this.reports.get(reference);
    if (original === undefined) throw new Error('Report reference expired.');
    // Return a copy so a caller cannot change the stored report.
    return JSON.parse(original) as CallToolResult;
  }

  private checkOwner(owner: symbol): void {
    if (owner !== this.owner || this.closed) {
      throw new Error('Report references are unavailable for this owner.');
    }
  }

  override async callToolResult(
    name: string,
    args: Record<string, unknown> | null,
    meta?: Record<string, unknown> | null,
    options?: MCPCallToolOptions,
  ): Promise<CallToolResult> {
    this.checkOwner(this.owner);
    const signal = options?.signal;
    const peerResult = await super.callToolResult(name, args, meta, options);
    signal?.throwIfAborted();
    this.checkOwner(this.owner);
    if (peerResult.isError) return peerResult;
    checkReport(peerResult);

    // The application finishes its own operation before the SDK sees success.
    const result = await this.resolveReport(peerResult, signal);
    signal?.throwIfAborted();
    this.checkOwner(this.owner);
    if (result.isError) return result;
    checkReport(result);
    const original = JSON.stringify(result);
    const bytes = Buffer.byteLength(original);
    const content = [...result.content];
    if (
      result.structuredContent !== undefined &&
      !content.some((block) => block.type === 'text')
    ) {
      content.push({
        type: 'text',
        text: JSON.stringify(result.structuredContent),
      });
    }
    const normalized = { ...result, content };
    if (visibleBytes(normalized) <= MAX_VISIBLE_BYTES) return normalized;
    if (
      bytes > MAX_REPORT_BYTES ||
      this.reports.size === MAX_REPORTS ||
      this.storedBytes + bytes > MAX_STORED_BYTES
    ) {
      throw new Error(
        'Report storage limit reached; no reference was created.',
      );
    }

    const reference = randomUUID();
    const preview = (text: string) => [...text].slice(0, 32).join('');
    const structuredPreview =
      result.structuredContent === undefined
        ? undefined
        : preview(JSON.stringify(result.structuredContent));
    const bounded: CallToolResult = {
      ...result,
      content: content.map((block) => {
        if (block.type !== 'text') return block;
        if (typeof block.text !== 'string') {
          throw new Error('Report text content must contain a string.');
        }
        return {
          ...block,
          text:
            `Stored report (${bytes} bytes). Preview: ${preview(block.text)}\n` +
            (structuredPreview === undefined
              ? ''
              : `Structured preview: ${structuredPreview}\n`) +
            `Reference: ${reference}`,
        };
      }),
      ...(result.structuredContent === undefined
        ? {}
        : {
            structuredContent: {
              preview: structuredPreview,
              reference,
              bytes,
            },
          }),
    };
    if (visibleBytes(bounded) > MAX_VISIBLE_BYTES) {
      throw new Error('The bounded report exceeds the visible result limit.');
    }
    // No await separates the final checks and publication of the complete copy.
    signal?.throwIfAborted();
    this.checkOwner(this.owner);
    this.reports.set(reference, original);
    this.storedBytes += bytes;
    return bounded;
  }

  override async close(): Promise<void> {
    this.closed = true;
    this.reports.clear();
    this.storedBytes = 0;
    await super.close();
  }
}

/** The caller owns the connected server, provider and returned Session. */
export async function openReportSession(
  server: ReportServer,
  provider: NativeProvider,
) {
  const tools = await selectMcpTools(
    { name: 'reports', server },
    { context: undefined, toolNames: ['report'] },
  );
  return new Agent({
    model: 'gpt-5.5',
    instructions:
      'Use reports.report to request the report. Summarize its preview and ' +
      'include its reference. The application retrieves the full report.',
    tools,
    provider,
  }).session();
}

async function main(): Promise<void> {
  const url = process.env.MCP_URL;
  if (!url) throw new Error('Set MCP_URL to your report server.');
  // Authentication chooses this identity; it never comes from model arguments.
  const owner = Symbol('authenticated report reader');
  const reports = new Map([
    [
      'example',
      { title: 'Quarterly report', text: 'Revenue grew. '.repeat(800) },
    ],
  ]);
  const server = new ReportServer(url, owner, async (result, signal) => {
    signal?.throwIfAborted();
    // Replace this demo map with the application's awaited report-service call.
    const report = reports.get(String(result.structuredContent?.reportId));
    if (!report) throw new Error('The application does not own this report.');
    return {
      content: result.content.map((block) =>
        block.type === 'text' ? { ...block, text: report.text } : block,
      ),
      structuredContent: report,
    };
  });
  try {
    await server.connect();
    await using provider = new NativeProvider({
      baseUrl: process.env.OPENAI_BASE_URL,
    });
    await using session = await openReportSession(server, provider);
    const result = await (
      await session.submit('Request the example report.')
    ).wait();
    console.log(result.finalOutput);
    for (const reference of server.references(owner)) {
      const original = server.read(owner, reference);
      console.log(
        `Retrieved ${Buffer.byteLength(JSON.stringify(original))} bytes.`,
      );
    }
  } finally {
    await server.close();
  }
}

// tsx runs source examples as CommonJS in this checkout.
if (typeof require !== 'undefined' && require.main === module) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
