/** One application-owned recovery intent, stored before one external operation. */
import { open, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';

const intentSchema = z.strictObject({
  sessionId: z.string().min(1),
  turnId: z.string().min(1),
  callId: z.string().min(1),
  businessKey: z.string().min(1),
});
export type RecoveryIntent = z.infer<typeof intentSchema>;

/** Use a new path in a trusted private directory for each operation. */
export async function recordRecoveryIntent(
  path: string,
  intent: RecoveryIntent,
): Promise<void> {
  const value = intentSchema.parse(intent);
  const file = await open(path, 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify(value), 'utf8');
    await file.sync();
  } finally {
    await file.close();
  }
  const directory = await open(dirname(path), 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

/** Read application data; never inspect or edit the opaque SDK snapshot. */
export async function readRecoveryIntent(
  path: string,
): Promise<RecoveryIntent> {
  return intentSchema.parse(JSON.parse(await readFile(path, 'utf8')));
}
