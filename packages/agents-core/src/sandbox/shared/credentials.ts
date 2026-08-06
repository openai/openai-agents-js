import { SandboxMountError, type SandboxErrorCode } from '../errors';

export type CredentialPairValidation = {
  accessKeyId?: string;
  secretAccessKey?: string;
  message: string;
  details?: Record<string, unknown>;
  code?: SandboxErrorCode;
};

export function validateCredentialPair({
  accessKeyId,
  secretAccessKey,
  message,
  details,
  code,
}: CredentialPairValidation): void {
  if (Boolean(accessKeyId) !== Boolean(secretAccessKey)) {
    throw new SandboxMountError(message, details, code);
  }
}
