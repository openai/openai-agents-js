import dotenv from 'dotenv';
import { buildServer } from './server';

// Load server-side credentials and the trusted public origin.
dotenv.config();

const fastify = buildServer({
  openAiApiKey: process.env.OPENAI_API_KEY ?? '',
  twilioAuthToken: process.env.TWILIO_AUTH_TOKEN ?? '',
  publicBaseUrl: process.env.TWILIO_PUBLIC_BASE_URL ?? '',
});
const port = Number(process.env.PORT || 5050);

fastify.listen({ port }, (err) => {
  if (err) {
    console.error('Failed to start the Twilio server.');
    process.exit(1);
  }
  console.log(`Server is listening on port ${port}`);
});

process.on('SIGINT', () => {
  void fastify.close();
});
