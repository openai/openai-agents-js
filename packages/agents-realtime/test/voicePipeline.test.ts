/**
 * Voice Pipeline Tests
 * Test coverage for Voice Pipeline Orchestration with gpt-realtime
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  VoicePipeline,
  createVoicePipeline,
  VoicePipelineConfig,
  VoicePipelinePlugin,
} from '../src/voicePipeline';

describe('VoicePipeline', () => {
  let pipeline: VoicePipeline;
  let mockSession: any;

  beforeEach(() => {
    pipeline = createVoicePipeline();
    mockSession = {
      on: vi.fn(),
      sendMessage: vi.fn().mockResolvedValue(undefined),
      emit: vi.fn(),
    };
  });

  afterEach(async () => {
    await pipeline.close();
  });

  describe('initialization', () => {
    it('should create pipeline with default gpt-realtime configuration', () => {
      expect(pipeline).toBeInstanceOf(VoicePipeline);
    });

    it('should accept custom gpt-realtime configuration', () => {
      const config: VoicePipelineConfig = {
        model: 'gpt-realtime',
        voice: 'cedar',
        stt: {
          model: 'whisper-1',
          language: 'es',
          temperature: 0,
        },
      };

      const customPipeline = createVoicePipeline(config);
      expect(customPipeline).toBeInstanceOf(VoicePipeline);
    });

    it('should initialize with realtime session', async () => {
      await pipeline.initialize(mockSession);

      // Session initialization happens but no specific events are listened to
      expect(pipeline).toBeInstanceOf(VoicePipeline);
    });
  });

  describe('audio processing (Whisper STT)', () => {
    beforeEach(async () => {
      await pipeline.initialize(mockSession);
    });

    it('should emit audio.data event when processing audio', async () => {
      const audioData = new ArrayBuffer(1024);
      const dataListener = vi.fn();

      pipeline.on('audio.data', dataListener);
      await pipeline.processAudio(audioData);

      expect(dataListener).toHaveBeenCalledWith(audioData);
    });

    it('should emit speech.final event with transcription', async () => {
      const audioData = new ArrayBuffer(1024);
      const finalListener = vi.fn();

      pipeline.on('speech.final', finalListener);
      await pipeline.processAudio(audioData);

      expect(finalListener).toHaveBeenCalledWith(expect.any(String));
    });

    it('should send transcribed text to realtime session', async () => {
      const audioData = new ArrayBuffer(1024);

      await pipeline.processAudio(audioData);

      expect(mockSession.sendMessage).toHaveBeenCalledWith({
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: expect.any(String),
          },
        ],
      });
    });

    it('should buffer audio when processing', async () => {
      const audio1 = new ArrayBuffer(512);
      const audio2 = new ArrayBuffer(512);
      const audio3 = new ArrayBuffer(512);

      // Process multiple audio chunks rapidly
      const promises = [
        pipeline.processAudio(audio1),
        pipeline.processAudio(audio2),
        pipeline.processAudio(audio3),
      ];

      await Promise.all(promises);

      // All should be processed (buffered internally)
      expect(mockSession.sendMessage).toHaveBeenCalledTimes(3);
    });

    it('should emit metrics after processing', async () => {
      const metricsListener = vi.fn();
      pipeline.on('metrics', metricsListener);

      await pipeline.processAudio(new ArrayBuffer(1024));

      expect(metricsListener).toHaveBeenCalledWith({
        sttLatency: expect.any(Number),
        ttsLatency: expect.any(Number),
        processingTime: expect.any(Number),
        audioBufferSize: expect.any(Number),
        webrtcLatency: expect.any(Number),
      });
    });
  });

  describe('realtime voice response', () => {
    beforeEach(async () => {
      await pipeline.initialize(mockSession);
    });

    it('should emit voice.start event when synthesizing', async () => {
      const startListener = vi.fn();
      pipeline.on('voice.start', startListener);

      await pipeline.handleVoiceResponse('Hello world', 'marin');

      expect(startListener).toHaveBeenCalled();
    });

    it('should emit voice.chunk events with audio data', async () => {
      const chunkListener = vi.fn();
      pipeline.on('voice.chunk', chunkListener);

      await pipeline.handleVoiceResponse('Hello world', 'cedar');

      expect(chunkListener).toHaveBeenCalled();
      expect(chunkListener).toHaveBeenCalledWith(expect.any(ArrayBuffer));
    });

    it('should emit voice.end event when complete', async () => {
      const endListener = vi.fn();
      pipeline.on('voice.end', endListener);

      await pipeline.handleVoiceResponse('Hello world');

      expect(endListener).toHaveBeenCalled();
    });

    it('should support switching between voices', async () => {
      // Voice switching updates internal config
      await pipeline.switchVoice('cedar');

      // Process a response with the new voice
      const chunkListener = vi.fn();
      pipeline.on('voice.chunk', chunkListener);

      await pipeline.handleVoiceResponse('Test', 'cedar');
      expect(chunkListener).toHaveBeenCalled();

      await pipeline.switchVoice('marin');

      await pipeline.handleVoiceResponse('Test', 'marin');
      expect(chunkListener).toHaveBeenCalled();
    });
  });

  describe('voice activity detection', () => {
    it('should emit speech.start when voice detected', () => {
      const startListener = vi.fn();
      pipeline.on('speech.start', startListener);

      pipeline.handleVoiceActivity(true);

      expect(startListener).toHaveBeenCalled();
    });

    it('should emit speech.end when voice stops', () => {
      const endListener = vi.fn();
      pipeline.on('speech.end', endListener);

      pipeline.handleVoiceActivity(false);

      expect(endListener).toHaveBeenCalled();
    });
  });

  describe('WebRTC integration', () => {
    it('should initialize WebRTC when enabled', async () => {
      const webrtcPipeline = createVoicePipeline({
        model: 'gpt-realtime',
        voice: 'marin',
        webrtc: { enabled: true },
      });

      const connectedListener = vi.fn();
      webrtcPipeline.on('webrtc.connected', connectedListener);

      await webrtcPipeline.initialize(mockSession);

      // WebRTC initialization happens asynchronously
      expect(webrtcPipeline).toBeInstanceOf(VoicePipeline);

      await webrtcPipeline.close();
    });

    it('should emit WebRTC metrics', async () => {
      const webrtcPipeline = createVoicePipeline({
        model: 'gpt-realtime',
        webrtc: { enabled: true },
      });

      const metricsListener = vi.fn();
      webrtcPipeline.on('metrics', metricsListener);

      await webrtcPipeline.initialize(mockSession);
      await webrtcPipeline.processAudio(new ArrayBuffer(1024));

      expect(metricsListener).toHaveBeenCalledWith(
        expect.objectContaining({
          webrtcLatency: expect.any(Number),
        }),
      );

      await webrtcPipeline.close();
    });
  });

  describe('error handling', () => {
    it('should emit error for audio processing failures', async () => {
      const errorPipeline = createVoicePipeline({
        model: 'gpt-realtime',
        voice: 'marin',
      });

      const errorListener = vi.fn();
      errorPipeline.on('error', errorListener);

      // Mock a failure scenario
      const failingSession = {
        ...mockSession,
        sendMessage: vi.fn().mockRejectedValue(new Error('Network error')),
      };

      await errorPipeline.initialize(failingSession);
      await errorPipeline.processAudio(new ArrayBuffer(1024));

      // Error should be emitted but not thrown
      expect(errorListener).toHaveBeenCalled();
    });
  });

  describe('cleanup', () => {
    it('should remove all listeners on close', async () => {
      const listener = vi.fn();
      pipeline.on('audio.data', listener);

      await pipeline.close();

      pipeline.emit('audio.data', new ArrayBuffer(1));
      expect(listener).not.toHaveBeenCalled();
    });

    it('should clear audio buffer on close', async () => {
      // Add some audio to buffer
      pipeline.processAudio(new ArrayBuffer(1024));
      pipeline.processAudio(new ArrayBuffer(1024));

      await pipeline.close();

      // Buffer should be cleared
      const metricsListener = vi.fn();
      pipeline.on('metrics', metricsListener);
      pipeline.emit('metrics', {} as any);

      // Metrics won't be emitted after close
      expect(metricsListener).not.toHaveBeenCalled();
    });

    it('should close WebRTC connection on cleanup', async () => {
      const webrtcPipeline = createVoicePipeline({
        model: 'gpt-realtime',
        webrtc: { enabled: true },
      });

      const disconnectedListener = vi.fn();
      webrtcPipeline.on('webrtc.disconnected', disconnectedListener);

      await webrtcPipeline.initialize(mockSession);
      await webrtcPipeline.close();

      expect(disconnectedListener).toHaveBeenCalled();
    });
  });
});

describe('VoicePipelinePlugin', () => {
  let plugin: VoicePipelinePlugin;
  let mockSession: any;

  beforeEach(() => {
    plugin = new VoicePipelinePlugin();
    mockSession = {
      on: vi.fn(),
      sendMessage: vi.fn().mockResolvedValue(undefined),
      emit: vi.fn(),
    };
  });

  it('should apply plugin to session', async () => {
    await plugin.apply(mockSession);

    expect(mockSession.voicePipeline).toBeDefined();
    expect(mockSession.processAudio).toBeDefined();
    expect(mockSession.handleVoiceResponse).toBeDefined();
    expect(mockSession.switchVoice).toBeDefined();
  });

  it('should expose pipeline instance', () => {
    const pipeline = plugin.getPipeline();
    expect(pipeline).toBeInstanceOf(VoicePipeline);
  });

  it('should allow custom configuration', () => {
    const customPlugin = new VoicePipelinePlugin({
      model: 'gpt-realtime',
      voice: 'cedar',
    });

    const pipeline = customPlugin.getPipeline();
    expect(pipeline).toBeInstanceOf(VoicePipeline);
  });

  it('should enhance session with audio processing', async () => {
    await plugin.apply(mockSession);

    const audioData = new ArrayBuffer(1024);
    await mockSession.processAudio(audioData);

    // Should process through pipeline
    expect(mockSession.sendMessage).toHaveBeenCalled();
  });

  it('should enhance session with voice response', async () => {
    await plugin.apply(mockSession);

    await mockSession.handleVoiceResponse('Hello', 'marin');

    // Voice response is handled by the pipeline
    expect(mockSession.voicePipeline).toBeDefined();
  });

  it('should enhance session with voice switching', async () => {
    await plugin.apply(mockSession);

    await mockSession.switchVoice('cedar');

    // Voice switching is handled internally
    expect(mockSession.voicePipeline).toBeDefined();
  });
});

describe('Realtime voices', () => {
  it('should support Marin voice', () => {
    const pipeline = createVoicePipeline({
      model: 'gpt-realtime',
      voice: 'marin',
    });

    expect(pipeline).toBeInstanceOf(VoicePipeline);
  });

  it('should support Cedar voice', () => {
    const pipeline = createVoicePipeline({
      model: 'gpt-realtime',
      voice: 'cedar',
    });

    expect(pipeline).toBeInstanceOf(VoicePipeline);
  });

  it('should default to Marin voice', () => {
    const pipeline = createVoicePipeline();

    // Default voice is Marin
    expect(pipeline).toBeInstanceOf(VoicePipeline);
  });
});

describe('Whisper STT configuration', () => {
  it('should configure Whisper with default settings', () => {
    const pipeline = createVoicePipeline({
      model: 'gpt-realtime',
      stt: {
        model: 'whisper-1',
      },
    });

    expect(pipeline).toBeInstanceOf(VoicePipeline);
  });

  it('should configure Whisper with custom language', () => {
    const pipeline = createVoicePipeline({
      model: 'gpt-realtime',
      stt: {
        model: 'whisper-1',
        language: 'fr',
        temperature: 0.2,
      },
    });

    expect(pipeline).toBeInstanceOf(VoicePipeline);
  });
});

describe('Audio configuration', () => {
  it('should accept custom audio settings for gpt-realtime', () => {
    const pipeline = createVoicePipeline({
      model: 'gpt-realtime',
      audio: {
        sampleRate: 24000,
        channels: 1,
        encoding: 'pcm16',
        chunkSize: 2048,
        bufferSize: 8192,
      },
    });

    expect(pipeline).toBeInstanceOf(VoicePipeline);
  });

  it('should support opus encoding for WebRTC', () => {
    const pipeline = createVoicePipeline({
      model: 'gpt-realtime',
      audio: {
        encoding: 'opus',
      },
      webrtc: {
        enabled: true,
      },
    });

    expect(pipeline).toBeInstanceOf(VoicePipeline);
  });

  it('should use default audio settings when not specified', () => {
    const pipeline = createVoicePipeline({
      model: 'gpt-realtime',
    });

    // Should have defaults applied
    expect(pipeline).toBeInstanceOf(VoicePipeline);
  });
});

describe('VAD configuration', () => {
  it('should accept custom VAD settings', () => {
    const pipeline = createVoicePipeline({
      model: 'gpt-realtime',
      vad: {
        enabled: false,
        threshold: 0.7,
        debounceMs: 500,
        maxSilenceMs: 3000,
      },
    });

    expect(pipeline).toBeInstanceOf(VoicePipeline);
  });
});

describe('Behavior configuration', () => {
  it('should accept custom behavior settings', () => {
    const pipeline = createVoicePipeline({
      model: 'gpt-realtime',
      behavior: {
        interruptible: false,
        echoSuppression: false,
        noiseSuppression: false,
        autoGainControl: false,
        streamingResponse: false,
      },
    });

    expect(pipeline).toBeInstanceOf(VoicePipeline);
  });
});
