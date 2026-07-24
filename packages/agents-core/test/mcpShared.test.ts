import { describe, expect, it, vi } from 'vitest';

vi.mock('debug', () => ({
  default: Object.assign(() => vi.fn(), { enabled: () => true }),
}));

import {
  BaseMCPServerSSE,
  BaseMCPServerStdio,
  BaseMCPServerStreamableHttp,
} from '../src/mcpShared';
import type { Logger } from '../src/logger';

const serverBases = [
  ['stdio', BaseMCPServerStdio],
  ['streamable HTTP', BaseMCPServerStreamableHttp],
  ['SSE', BaseMCPServerSSE],
] as const;

function createServer(
  Base: (typeof serverBases)[number][1],
  logger: Logger,
): { emitDebug: (buildMessage: () => string) => void } {
  const TestServer = class extends (Base as any) {
    constructor(options: { logger: Logger }) {
      super(options);
    }

    get name() {
      return 'test';
    }

    emitDebug(buildMessage: () => string): void {
      this.debugLog(buildMessage);
    }
  };

  return new TestServer({ logger });
}

describe('MCP shared debug logging', () => {
  it.each(serverBases)(
    'does not build %s tool messages when tool logging is disabled',
    (_name, Base) => {
      const debug = vi.fn();
      const logger: Logger = {
        namespace: 'mcp-shared-test',
        debug,
        error: vi.fn(),
        warn: vi.fn(),
        dontLogModelData: false,
        dontLogToolData: true,
      };
      const server = createServer(Base, logger);
      const secret = 'SECRET_MCP_DEBUG_PAYLOAD_123';
      const buildMessage = vi.fn(() => secret);

      server.emitDebug(buildMessage);

      expect(buildMessage).not.toHaveBeenCalled();
      expect(debug).not.toHaveBeenCalled();
    },
  );

  it.each(serverBases)(
    'preserves %s diagnostics when tool logging is enabled',
    (_name, Base) => {
      const debug = vi.fn();
      const logger: Logger = {
        namespace: 'mcp-shared-test',
        debug,
        error: vi.fn(),
        warn: vi.fn(),
        dontLogModelData: false,
        dontLogToolData: false,
      };
      const server = createServer(Base, logger);
      const secret = 'SECRET_MCP_DEBUG_DIAGNOSTIC_123';

      server.emitDebug(() => secret);

      expect(debug).toHaveBeenCalledWith(secret);
    },
  );
});
