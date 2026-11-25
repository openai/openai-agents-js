declare module '#agents-native-history' {
  const bindings:
    import('../runner/nativeInputHistory').NativeHistoryBindings | undefined;
  export default bindings;
}
