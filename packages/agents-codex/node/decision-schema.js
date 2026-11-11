/* global exports */
// TypeScript's CommonJS target rewrites import() to require(). Keep this bridge
// outside the compiler so Node 22 can load the ESM-only schema dependency.
exports.loadDecisionSchema = () =>
  import('@hyperjump/json-schema/draft-2020-12');

exports.loadFormSchemas = async () => {
  const [browser, draft, experimental, instance, uri] = await Promise.all([
    import('@hyperjump/browser'),
    import('@hyperjump/json-schema/draft-2020-12'),
    import('@hyperjump/json-schema/experimental'),
    import('@hyperjump/json-schema/instance/experimental'),
    import('@hyperjump/uri'),
  ]);
  return {
    schemaValue: browser.value,
    registerSchema: draft.registerSchema,
    unregisterSchema: draft.unregisterSchema,
    compileSchema: draft.validate,
    addKeyword: experimental.addKeyword,
    defineVocabulary: experimental.defineVocabulary,
    getKeywordId: experimental.getKeywordId,
    instanceValue: instance.value,
    parseUri: uri.parseUri,
  };
};
