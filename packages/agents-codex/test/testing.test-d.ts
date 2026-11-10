import {
  httpError,
  withScriptedResponses,
  type ScriptedResult,
} from '../src/testing';

const result: ScriptedResult = httpError(400);
const useDynamicErrors = () =>
  withScriptedResponses(
    [() => httpError(400), async () => httpError(503)],
    async () => {},
  );

void [result, useDynamicErrors];
