/** Test-only crash at the durable public-result boundary, before native delivery. */
import { Journal } from '../../../../../examples/codex/external-job-journal';
import { ThumbnailStore } from '../../../../../examples/codex/external-job-store';
import { advanceMCPOrder } from '../../../../../examples/codex/mcp-tasks';

class CrashAfterSave extends Journal {
  override async saveResult(...args: Parameters<Journal['saveResult']>) {
    await super.saveResult(...args);
    process.exit(73);
  }
}

const [directory, order, mcpPort, modelPort] = process.argv.slice(2);
if (!directory || !order) throw new Error('Missing fixture state.');
void advanceMCPOrder(
  new CrashAfterSave(new ThumbnailStore(directory, 'local-mcp-studio'), order),
  { mcpPort: Number(mcpPort), modelPort: Number(modelPort) },
).catch(() => {
  console.error('Crash fixture failed before saving its result.');
  process.exitCode = 1;
});
