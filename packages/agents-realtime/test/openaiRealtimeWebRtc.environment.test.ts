import { describe, it, expect } from 'vitest';
import { OpenAIRealtimeWebRTC } from '../src/openaiRealtimeWebRtc';

describe('OpenAIRealtimeWebRTC constructor', () => {
  it('throws if WebRTC is not available', () => {
    const original = (global as any).RTCPeerConnection;
    delete (global as any).RTCPeerConnection;

    expect(() => new OpenAIRealtimeWebRTC()).toThrow(
      'WebRTC is not supported in this environment',
    );

    (global as any).RTCPeerConnection = original;
  });
});
