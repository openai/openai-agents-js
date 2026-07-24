function isPrimitiveOutputType(value: unknown): boolean {
  return (
    value === null || (typeof value !== 'object' && typeof value !== 'function')
  );
}

/**
 * Returns true only when different output types can be established without inspecting schema
 * objects. Distinct schema objects may still be structurally equivalent, so they remain unknown.
 *
 * @internal
 */
export function hasDefinitelyDifferentOutputTypes(
  outputTypes: unknown[],
): boolean {
  if (outputTypes.length < 2) {
    return false;
  }
  const firstOutputType = outputTypes[0];

  return outputTypes.slice(1).some((outputType) => {
    if (Object.is(outputType, firstOutputType)) {
      return false;
    }
    return (
      isPrimitiveOutputType(firstOutputType) ||
      isPrimitiveOutputType(outputType)
    );
  });
}
