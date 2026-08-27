export const MAX_SDP_BYTES = 256 * 1024;

export class SdpPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SdpPolicyError';
  }
}

type MediaDescription = {
  kind: string;
  port: number;
};

function parseMediaDescription(line: string): MediaDescription | null {
  const match = /^\s*m\s*=\s*([^\s]+)\s+([^\s]+)(?:\s+|$)/i.exec(line);
  if (!match) {
    return null;
  }

  const kind = match[1]?.toLowerCase();
  const portToken = match[2]?.split('/', 1)[0];
  const port = Number(portToken);
  if (!kind || !Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new SdpPolicyError('The SDP contains an invalid media description.');
  }

  return { kind, port };
}

export function assertAudioOnlySdp(sdp: string): void {
  if (typeof sdp !== 'string') {
    throw new SdpPolicyError('The SDP must be a string.');
  }

  if (new TextEncoder().encode(sdp).byteLength > MAX_SDP_BYTES) {
    throw new SdpPolicyError('The SDP is too large.');
  }

  const lines = sdp.split(/\r\n|\n|\r/);
  if (lines[0]?.trim() !== 'v=0') {
    throw new SdpPolicyError('The SDP must start with v=0.');
  }

  const mediaDescriptions: MediaDescription[] = [];
  for (const line of lines) {
    const trimmed = line.trimStart();
    if (/^m\s*=/i.test(trimmed)) {
      const media = parseMediaDescription(line);
      if (!media) {
        throw new SdpPolicyError(
          'The SDP contains an invalid media description.',
        );
      }
      mediaDescriptions.push(media);
    }
  }

  if (mediaDescriptions.length !== 1) {
    throw new SdpPolicyError(
      'The SDP must contain exactly one media description.',
    );
  }

  const [media] = mediaDescriptions;
  if (media?.kind !== 'audio' || media.port === 0) {
    throw new SdpPolicyError(
      'The SDP must contain exactly one active audio media description.',
    );
  }
}
