export function getToken(): string | null {
  return prompt(
    'Enter an ephemeral client secret. Run `pnpm -F realtime-next generate-token` locally to create one.',
  );
}
