export declare function loadDecisionSchema(): Promise<
  typeof import('@hyperjump/json-schema/draft-2020-12')
>;

export declare function loadFormSchemas(): Promise<{
  schemaValue: typeof import('@hyperjump/browser').value;
  registerSchema: typeof import('@hyperjump/json-schema/draft-2020-12').registerSchema;
  unregisterSchema: typeof import('@hyperjump/json-schema/draft-2020-12').unregisterSchema;
  compileSchema: typeof import('@hyperjump/json-schema/draft-2020-12').validate;
  addKeyword: typeof import('@hyperjump/json-schema/experimental').addKeyword;
  defineVocabulary: typeof import('@hyperjump/json-schema/experimental').defineVocabulary;
  getKeywordId: typeof import('@hyperjump/json-schema/experimental').getKeywordId;
  instanceValue: typeof import('@hyperjump/json-schema/instance/experimental').value;
  parseUri: typeof import('@hyperjump/uri').parseUri;
}>;
