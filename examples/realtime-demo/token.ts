import OpenAI from 'openai';

const MIN_TTL_SECONDS = 10;
const MAX_TTL_SECONDS = 7200;

function parseTtlSeconds() {
  const ttlArg = process.argv.find((arg) => arg.startsWith('--ttl-seconds='));
  const ttlValue =
    ttlArg?.slice('--ttl-seconds='.length) ??
    process.env.REALTIME_CLIENT_SECRET_TTL_SECONDS;

  if (!ttlValue) {
    return undefined;
  }

  const ttlSeconds = Number(ttlValue);
  if (
    !Number.isInteger(ttlSeconds) ||
    ttlSeconds < MIN_TTL_SECONDS ||
    ttlSeconds > MAX_TTL_SECONDS
  ) {
    throw new Error(
      `Expected --ttl-seconds to be an integer between ${MIN_TTL_SECONDS} and ${MAX_TTL_SECONDS}.`,
    );
  }

  return ttlSeconds;
}

async function generateToken() {
  const ttlSeconds = parseTtlSeconds();
  const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });

  const session = await openai.realtime.clientSecrets.create({
    ...(ttlSeconds
      ? {
          expires_after: {
            anchor: 'created_at',
            seconds: ttlSeconds,
          },
        }
      : {}),
    session: {
      type: 'realtime',
      model: 'gpt-realtime-2',
    },
  });

  console.log(session.value);
}

generateToken().catch((err) => {
  console.error('Failed to create ephemeral token', err);
  process.exit(1);
});
