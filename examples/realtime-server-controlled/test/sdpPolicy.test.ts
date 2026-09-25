import { describe, expect, it } from 'vitest';
import {
  assertAudioOnlySdp,
  MAX_SDP_BYTES,
  SdpPolicyError,
} from '../src/server/sdpPolicy';

const audioOnlySdp = [
  'v=0',
  'o=- 1 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111',
  'a=mid:0',
].join('\r\n');

describe('assertAudioOnlySdp', () => {
  it('accepts exactly one active audio media description', () => {
    expect(() => assertAudioOnlySdp(audioOnlySdp)).not.toThrow();
  });

  it.each([
    {
      name: 'a data channel',
      line: 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    },
    { name: 'video', line: 'm=video 9 UDP/TLS/RTP/SAVPF 96' },
    { name: 'a second audio section', line: 'm=audio 9 RTP/AVP 0' },
  ])('rejects $name', ({ line }) => {
    expect(() => assertAudioOnlySdp(`${audioOnlySdp}\r\n${line}`)).toThrow(
      SdpPolicyError,
    );
  });

  it('detects a noncanonical application media description', () => {
    expect(() =>
      assertAudioOnlySdp(
        `${audioOnlySdp}\r\n  M = application 9 UDP/DTLS/SCTP webrtc-datachannel`,
      ),
    ).toThrow(SdpPolicyError);
  });

  it.each([
    ['missing audio', ['v=0', 's=-', 't=0 0'].join('\r\n')],
    ['rejected audio', audioOnlySdp.replace('m=audio 9', 'm=audio 0')],
    ['missing version', audioOnlySdp.replace('v=0\r\n', '')],
  ])('rejects %s SDP', (_name, sdp) => {
    expect(() => assertAudioOnlySdp(sdp)).toThrow(SdpPolicyError);
  });

  it('rejects an oversized SDP', () => {
    const oversized = `${audioOnlySdp}\r\na=x:${'x'.repeat(MAX_SDP_BYTES)}`;
    expect(() => assertAudioOnlySdp(oversized)).toThrow('too large');
  });
});
