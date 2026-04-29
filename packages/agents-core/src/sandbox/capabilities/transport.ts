export function supportsResponsesCompactionTransport(
  modelInstance: unknown,
): boolean {
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
