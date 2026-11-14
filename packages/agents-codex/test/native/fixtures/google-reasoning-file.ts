export const thoughtFileData = 'UkVBU09OSU5HX0ZJTEVfT05MWV83MzE=';
export const googleResponse = {
  responseId: 'google_fixture_response',
  modelVersion: 'gemini-2.5-flash-image',
  candidates: [
    {
      content: {
        role: 'model',
        parts: [
          {
            thought: true,
            inlineData: { mimeType: 'image/png', data: thoughtFileData },
          },
          { text: 'Visible answer.' },
        ],
      },
      index: 0,
      finishReason: 'STOP',
    },
  ],
  usageMetadata: {
    promptTokenCount: 5,
    candidatesTokenCount: 2,
    totalTokenCount: 7,
  },
};
