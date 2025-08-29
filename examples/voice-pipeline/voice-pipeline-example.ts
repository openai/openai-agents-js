/**
 * Voice Pipeline Orchestration Example
 * Demonstrates TTS/STT orchestration with OpenAI gpt-realtime
 *
 * This example shows how to:
 * - Set up voice pipeline with gpt-realtime model
 * - Process audio through Whisper STT
 * - Generate speech with realtime voices (Marin, Cedar)
 * - Handle voice activity detection
 * - Monitor pipeline metrics with WebRTC
 */

import {
  RealtimeAgent,
  RealtimeSession,
  createVoicePipeline,
  VoicePipelineConfig,
  tool,
} from '@openai/agents/realtime';

// Configure voice pipeline for gpt-realtime
const pipelineConfig: VoicePipelineConfig = {
  // Realtime model configuration
  model: 'gpt-realtime',
  voice: 'marin', // Options: 'marin', 'cedar'

  // Speech-to-Text configuration with Whisper
  stt: {
    model: 'whisper-1',
    language: 'en',
    temperature: 0,
  },

  // Audio processing settings
  audio: {
    sampleRate: 24000, // Optimized for realtime
    channels: 1, // Mono audio
    encoding: 'pcm16', // 16-bit PCM
    chunkSize: 1024, // Process in 1KB chunks
    bufferSize: 4096, // 4KB buffer
  },

  // Voice Activity Detection
  vad: {
    enabled: true, // Enable VAD
    threshold: 0.5, // Detection threshold
    debounceMs: 300, // Debounce period
    maxSilenceMs: 2000, // Max silence before end
  },

  // WebRTC for ultra-low latency
  webrtc: {
    enabled: true,
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  },

  // Audio enhancement
  behavior: {
    interruptible: true, // Allow interruptions
    echoSuppression: true, // Remove echo
    noiseSuppression: true, // Remove background noise
    autoGainControl: true, // Normalize volume
    streamingResponse: true, // Stream responses
  },
};

// Create a voice-enabled agent
const voiceAgent = new RealtimeAgent({
  name: 'Realtime Voice Assistant',
  instructions: `You are a helpful voice assistant using gpt-realtime.
    - Respond concisely and naturally
    - Use conversational language
    - Ask clarifying questions when needed
    - Provide helpful suggestions`,
  tools: [
    // Weather tool
    tool({
      name: 'get_weather',
      description: 'Get current weather for a location',
      parameters: {
        type: 'object',
        properties: {
          location: {
            type: 'string',
            description: 'City name or location',
          },
        },
        required: ['location'],
      },
      execute: async ({ location }) => {
        // Simulate weather API call
        const weather = {
          location,
          temperature: Math.floor(Math.random() * 30) + 50,
          condition: ['sunny', 'cloudy', 'rainy'][
            Math.floor(Math.random() * 3)
          ],
          humidity: Math.floor(Math.random() * 40) + 40,
        };

        return `Weather in ${weather.location}: ${weather.temperature}°F, ${weather.condition}, ${weather.humidity}% humidity`;
      },
    }),

    // Calculator tool
    tool({
      name: 'calculate',
      description: 'Perform mathematical calculations',
      parameters: {
        type: 'object',
        properties: {
          expression: {
            type: 'string',
            description: 'Mathematical expression to evaluate',
          },
        },
        required: ['expression'],
      },
      execute: async ({ expression }) => {
        try {
          // Simple safe eval for demo (use math.js in production)
          const result = Function(`"use strict"; return (${expression})`)();
          return `Result: ${result}`;
        } catch (_error) {
          return `Error: Invalid expression`;
        }
      },
    }),

    // Timer tool
    tool({
      name: 'set_timer',
      description: 'Set a timer for a specified duration',
      parameters: {
        type: 'object',
        properties: {
          duration: {
            type: 'number',
            description: 'Duration in seconds',
          },
          label: {
            type: 'string',
            description: 'Timer label or description',
          },
        },
        required: ['duration'],
      },
      execute: async ({ duration, label }) => {
        console.log(`Timer set: ${label || 'Timer'} for ${duration} seconds`);

        setTimeout(() => {
          console.log(`⏰ Timer expired: ${label || 'Timer'}`);
        }, duration * 1000);

        return `Timer set for ${duration} seconds${label ? `: ${label}` : ''}`;
      },
    }),
  ],
});

async function main() {
  console.log('🎙️ gpt-realtime Voice Pipeline Example Starting...\n');

  // Create voice pipeline
  const pipeline = createVoicePipeline(pipelineConfig);

  // Set up event listeners
  setupPipelineListeners(pipeline);

  // Create realtime session
  const session = new RealtimeSession({
    agent: voiceAgent,
    model: 'gpt-realtime',
    voice: 'marin',
  });

  // Initialize pipeline with session
  await pipeline.initialize(session);
  console.log('✅ Voice pipeline initialized with gpt-realtime\n');

  // Demonstrate voice switching
  await demonstrateVoiceSwitching(pipeline);

  // Simulate voice interactions
  await simulateVoiceConversation(pipeline, session);

  // Monitor metrics
  monitorPipelineMetrics(pipeline);

  // Keep running for demo
  console.log(
    '\n📊 Pipeline running with gpt-realtime. Press Ctrl+C to stop.\n',
  );
}

function setupPipelineListeners(pipeline: any) {
  // Audio events
  pipeline.on('audio.start', () => {
    console.log('🎤 Audio input started');
  });

  pipeline.on('audio.stop', () => {
    console.log('🔇 Audio input stopped');
  });

  // Speech recognition events (Whisper)
  pipeline.on('speech.start', () => {
    console.log('👄 Speech detected');
  });

  pipeline.on('speech.end', () => {
    console.log('🤐 Speech ended');
  });

  pipeline.on('speech.partial', (text: string) => {
    console.log(`📝 Whisper partial: "${text}"`);
  });

  pipeline.on('speech.final', (text: string) => {
    console.log(`✍️ Whisper final: "${text}"`);
  });

  // Realtime voice events
  pipeline.on('voice.start', () => {
    console.log('🔊 Starting realtime voice response');
  });

  pipeline.on('voice.chunk', (audio: ArrayBuffer) => {
    console.log(`🎵 Voice chunk: ${audio.byteLength} bytes`);
  });

  pipeline.on('voice.end', () => {
    console.log('🔈 Realtime voice complete');
  });

  // WebRTC events
  pipeline.on('webrtc.connected', () => {
    console.log('🌐 WebRTC connected (ultra-low latency mode)');
  });

  pipeline.on('webrtc.disconnected', () => {
    console.log('🔌 WebRTC disconnected');
  });

  // Error handling
  pipeline.on('error', (error: Error) => {
    console.error('❌ Pipeline error:', error.message);
  });
}

async function demonstrateVoiceSwitching(pipeline: any) {
  console.log('🎭 Demonstrating realtime voice switching...\n');

  // Start with Marin
  console.log('Using Marin voice (default)');
  await pipeline.handleVoiceResponse(
    'Hello, I am Marin. My voice is optimized for clarity.',
    'marin',
  );

  await new Promise((resolve) => setTimeout(resolve, 2000));

  // Switch to Cedar
  console.log('\nSwitching to Cedar voice...');
  await pipeline.switchVoice('cedar');
  await pipeline.handleVoiceResponse(
    'Hi there! I am Cedar. My voice has a warm, friendly tone.',
    'cedar',
  );

  await new Promise((resolve) => setTimeout(resolve, 2000));

  // Switch back to Marin
  console.log('\nSwitching back to Marin voice...');
  await pipeline.switchVoice('marin');
  console.log('Voice switching complete!\n');
}

async function simulateVoiceConversation(pipeline: any, _session: any) {
  console.log('🎭 Simulating voice conversation with gpt-realtime...\n');

  const userInputs = [
    "What's the weather like in San Francisco?",
    'Calculate 25 times 4 plus 10',
    'Set a timer for 30 seconds',
  ];

  for (const input of userInputs) {
    console.log(`\n👤 User: "${input}"`);

    // Simulate Whisper processing
    const audioBuffer = textToAudioSimulation(input);

    // Process through Whisper STT pipeline
    await pipeline.processAudio(audioBuffer);

    // Simulate agent response
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Generate realtime voice response
    const response = await generateAgentResponse(input);
    console.log(`🤖 Agent (gpt-realtime): "${response}"`);

    // Synthesize with realtime voice
    await pipeline.handleVoiceResponse(response, 'marin');

    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

function textToAudioSimulation(text: string): ArrayBuffer {
  // Simulate converting text to audio buffer
  // In real implementation, this would be actual audio data
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  return data.buffer;
}

async function generateAgentResponse(input: string): Promise<string> {
  // Simulate gpt-realtime responses
  if (input.includes('weather')) {
    return 'The weather in San Francisco is currently 68°F and partly cloudy with 65% humidity.';
  } else if (input.includes('Calculate')) {
    return '25 times 4 plus 10 equals 110.';
  } else if (input.includes('timer')) {
    return "I've set a 30-second timer for you. I'll let you know when it's done.";
  } else {
    return 'I can help you with weather information, calculations, and setting timers. What would you like to know?';
  }
}

function monitorPipelineMetrics(pipeline: any) {
  pipeline.on('metrics', (metrics: any) => {
    console.log('\n📈 gpt-realtime Pipeline Metrics:');
    console.log(`  Whisper STT Latency: ${metrics.sttLatency}ms`);
    console.log(`  Realtime Voice Latency: ${metrics.ttsLatency}ms`);
    console.log(`  Processing Time: ${metrics.processingTime}ms`);
    console.log(`  Buffer Size: ${metrics.audioBufferSize}`);
    console.log(`  WebRTC Latency: ${metrics.webrtcLatency}ms`);

    if (metrics.transcriptionAccuracy) {
      console.log(
        `  Whisper Accuracy: ${(metrics.transcriptionAccuracy * 100).toFixed(1)}%`,
      );
    }
  });
}

// Advanced: WebRTC configuration for ultra-low latency
async function _demonstrateWebRTC() {
  console.log('\n🌐 Demonstrating WebRTC ultra-low latency mode...\n');

  const webrtcPipeline = createVoicePipeline({
    model: 'gpt-realtime',
    voice: 'marin',
    webrtc: {
      enabled: true,
      audioConstraints: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        sampleRate: 48000,
      },
    },
    behavior: {
      interruptible: true,
      streamingResponse: true,
    },
  });

  webrtcPipeline.on('webrtc.connected', () => {
    console.log('✅ WebRTC connected - achieving <100ms latency');
  });

  webrtcPipeline.on('metrics', (metrics: any) => {
    if (metrics.webrtcLatency < 100) {
      console.log(`🚀 Ultra-low latency achieved: ${metrics.webrtcLatency}ms`);
    }
  });

  const session = new RealtimeSession({
    model: 'gpt-realtime',
    transport: 'webrtc',
  });

  await webrtcPipeline.initialize(session);
  console.log('WebRTC pipeline ready for ultra-low latency voice interactions');
}

// Run the example
if (require.main === module) {
  main().catch(console.error);

  // Optionally demonstrate WebRTC
  // _demonstrateWebRTC().catch(console.error);
}
