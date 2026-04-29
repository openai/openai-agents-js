import { randomUUID } from '@openai/agents-core/_shims';

const APPROX_BYTES_PER_TOKEN = 4;

export function truncateOutput(
  output: string,
  maxOutputTokens?: number,
): { text: string; originalTokenCount?: number } {
  if (maxOutputTokens == null) {
    return { text: output };
  }

  const maxBytes = Math.max(0, maxOutputTokens) * APPROX_BYTES_PER_TOKEN;
  const outputBytes = byteLength(output);
  if (outputBytes <= maxBytes) {
    return { text: output };
  }

  const originalTokenCount = approximateTokenCountFromBytes(outputBytes);
  const totalLines = countLines(output);
  const marker = `...${approximateTokenCountFromBytes(outputBytes - maxBytes)} tokens truncated...`;
  const preservedPrefix = getPreservedLeadingNotice(output);
  const prefixBytes = byteLength(preservedPrefix);
  const body = preservedPrefix ? output.slice(preservedPrefix.length) : output;
  const bodyBudget = Math.max(0, maxBytes - prefixBytes);
  const truncatedBody =
    bodyBudget === 0
      ? marker
      : truncateWithByteBudget(body, bodyBudget, marker);
  const truncated = `${preservedPrefix}${truncatedBody}`;

  return {
    text: `Total output lines: ${totalLines}\n\n${truncated}`,
    originalTokenCount,
  };
}

export function formatExecResponse(args: {
  output: string;
  wallTimeSeconds: number;
  sessionId?: number;
  exitCode?: number | null;
  originalTokenCount?: number;
}): string {
  const lines = [
    `Chunk ID: ${randomUUID().replace(/-/g, '').slice(0, 6)}`,
    `Wall time: ${args.wallTimeSeconds.toFixed(4)} seconds`,
  ];

  if (typeof args.sessionId === 'number') {
    lines.push(`Process running with session ID ${args.sessionId}`);
  } else if (typeof args.exitCode === 'number') {
    lines.push(`Process exited with code ${args.exitCode}`);
  }

  if (typeof args.originalTokenCount === 'number') {
    lines.push(`Original token count: ${args.originalTokenCount}`);
  }

  lines.push('Output:');
  lines.push(args.output);
  return lines.join('\n');
}

export function elapsedSeconds(start: number): number {
  return (Date.now() - start) / 1000;
}

function truncateWithByteBudget(
  output: string,
  maxBytes: number,
  marker: string,
): string {
  const leftBudget = Math.floor(maxBytes / 2);
  const rightBudget = maxBytes - leftBudget;
  const totalBytes = byteLength(output);
  const tailStartTarget = Math.max(0, totalBytes - rightBudget);
  let prefixEnd = 0;
  let suffixStart = totalBytes;
  let suffixStarted = false;
  let byteIndex = 0;

  for (const character of output) {
    const characterBytes = byteLength(character);
    const characterEnd = byteIndex + characterBytes;
    if (characterEnd <= leftBudget) {
      prefixEnd = characterEnd;
      byteIndex = characterEnd;
      continue;
    }

    if (byteIndex >= tailStartTarget) {
      if (!suffixStarted) {
        suffixStart = byteIndex;
        suffixStarted = true;
      }
      byteIndex = characterEnd;
      continue;
    }

    byteIndex = characterEnd;
  }

  if (suffixStart < prefixEnd) {
    suffixStart = prefixEnd;
  }

  const bytes = new TextEncoder().encode(output);
  const prefix = new TextDecoder().decode(bytes.slice(0, prefixEnd));
  const suffix = new TextDecoder().decode(bytes.slice(suffixStart));
  return `${prefix}${marker}${suffix}`;
}

function getPreservedLeadingNotice(output: string): string {
  const match = output.match(
    /^\[\.\.\.\d+ characters truncated from process output\.\.\.\]\n/u,
  );
  return match?.[0] ?? '';
}

function countLines(output: string): number {
  if (output.length === 0) {
    return 0;
  }
  return output.split(/\r\n|\r|\n/).length;
}

function byteLength(output: string): number {
  return new TextEncoder().encode(output).byteLength;
}

function approximateTokenCountFromBytes(bytes: number): number {
  if (bytes <= 0) {
    return 0;
  }
  return Math.ceil(bytes / APPROX_BYTES_PER_TOKEN);
}
