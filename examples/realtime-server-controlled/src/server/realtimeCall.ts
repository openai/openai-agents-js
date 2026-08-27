import { assertAudioOnlySdp } from './sdpPolicy';

export type RealtimeCall = {
  answerSdp: string;
  callId: string;
};

export type CreateRealtimeCallOptions = {
  apiKey: string;
  hangupCall: (callId: string) => Promise<void>;
  model: string;
  offerSdp: string;
  safetyIdentifier: string;
  signal?: AbortSignal;
  voice: string;
  fetchImpl?: typeof fetch;
};

function parseCallId(location: string | null): string {
  if (!location) {
    throw new Error('Realtime did not return a call location.');
  }

  const url = new URL(location, 'https://api.openai.com');
  if (url.origin !== 'https://api.openai.com') {
    throw new Error('Realtime returned an invalid call location.');
  }
  const match = /^\/v1\/realtime\/calls\/(rtc_[A-Za-z0-9_-]+)$/.exec(
    url.pathname,
  );
  if (!match?.[1]) {
    throw new Error('Realtime returned an invalid call location.');
  }
  return match[1];
}

export async function createRealtimeCall(
  options: CreateRealtimeCallOptions,
): Promise<RealtimeCall> {
  assertAudioOnlySdp(options.offerSdp);

  const form = new FormData();
  form.set('sdp', options.offerSdp);
  form.set(
    'session',
    JSON.stringify({
      type: 'realtime',
      model: options.model,
      audio: { output: { voice: options.voice } },
    }),
  );

  const timeoutSignal = AbortSignal.timeout(15_000);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal;
  const response = await (options.fetchImpl ?? fetch)(
    'https://api.openai.com/v1/realtime/calls',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        'OpenAI-Safety-Identifier': options.safetyIdentifier,
      },
      body: form,
      redirect: 'error',
      signal,
    },
  );
  if (!response.ok) {
    throw new Error(
      `Realtime call creation failed with status ${response.status}.`,
    );
  }

  const callId = parseCallId(response.headers.get('location'));
  try {
    const answerSdp = await response.text();
    assertAudioOnlySdp(answerSdp);
    return { answerSdp, callId };
  } catch (error) {
    try {
      await options.hangupCall(callId);
    } catch {
      // Preserve the response validation error after best-effort cleanup.
    }
    throw error;
  }
}
