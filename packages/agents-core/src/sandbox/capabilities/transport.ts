import type { Model } from '../../model';

export function supportsResponsesCompactionTransport(
  modelInstance: unknown,
): boolean {
  const capabilities = (modelInstance as Model | undefined)
    ?._sandboxModelCapabilities;
  if (capabilities?.responsesCompaction !== undefined) {
    return capabilities.responsesCompaction;
  }
  if (!modelInstance) {
    return true;
  }

  const constructorName =
    typeof modelInstance === 'object' &&
    modelInstance &&
    'constructor' in modelInstance &&
    typeof modelInstance.constructor === 'function'
      ? modelInstance.constructor.name
      : '';

  return !constructorName.includes('ChatCompletions');
}

export function supportsApplyPatchTransport(modelInstance: unknown): boolean {
  const capabilities = (modelInstance as Model | undefined)
    ?._sandboxModelCapabilities;
  if (capabilities?.hostedApplyPatch !== undefined) {
    return capabilities.hostedApplyPatch;
  }
  return supportsStructuredToolOutputTransport(modelInstance);
}

export function supportsStructuredToolOutputTransport(
  modelInstance: unknown,
): boolean {
  if (!modelInstance) {
    return false;
  }

  const constructorName =
    typeof modelInstance === 'object' &&
    modelInstance &&
    'constructor' in modelInstance &&
    typeof modelInstance.constructor === 'function'
      ? modelInstance.constructor.name
      : '';

  return !constructorName.includes('ChatCompletions');
}
