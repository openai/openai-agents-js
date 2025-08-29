# Voice Pipeline Orchestration Example

This example demonstrates the Voice Pipeline Orchestration feature for OpenAI's gpt-realtime model, providing seamless TTS/STT capabilities.

## Features Demonstrated

- **gpt-realtime Integration**: Native support for OpenAI's realtime model
- **Realtime Voices**: Marin and Cedar voice options
- **Whisper STT**: High-quality speech recognition
- **WebRTC Support**: Ultra-low latency (<100ms) voice streaming
- **Voice Activity Detection**: Automatic speech detection
- **Audio Enhancement**: Echo/noise suppression and gain control
- **Metrics Monitoring**: Track pipeline performance

## Prerequisites

1. OpenAI API key with access to:
   - gpt-realtime model
   - Whisper (speech-to-text)
   - Realtime voices (Marin, Cedar)

## Setup

```bash
# Install dependencies
pnpm install

# Set environment variables
export OPENAI_API_KEY="your-api-key"
```

## Running the Example

```bash
# Run the example
pnpm start

# Run in development mode with auto-reload
pnpm dev
```

## What It Does

1. **Initializes Voice Pipeline**: Sets up gpt-realtime with Whisper STT
2. **Demonstrates Voice Switching**: Shows switching between Marin and Cedar voices
3. **Simulates Conversation**: Processes sample voice interactions
4. **Shows Tool Usage**: Weather, calculator, and timer tools
5. **Monitors Metrics**: Displays latency and performance metrics
6. **WebRTC Mode**: Optional ultra-low latency configuration

## Key Components

### gpt-realtime Model

The cutting-edge realtime model providing natural voice interactions with minimal latency.

### Realtime Voices

- **Marin**: Optimized for clarity and professional tone
- **Cedar**: Warm and friendly for conversational interactions

### Whisper STT

OpenAI's state-of-the-art speech recognition for accurate transcription.

### WebRTC Integration

Enables ultra-low latency (<100ms) for real-time conversations.

## Architecture

```
User Audio → Whisper STT → gpt-realtime → Realtime Voice → Audio Output
     ↑                            ↓
     └─── Voice Activity ←────────┘
          Detection (VAD)
```

## Configuration Options

### Audio Settings

- Sample Rate: 24kHz (optimized for realtime)
- Encoding: PCM16 or Opus (for WebRTC)
- Channels: Mono

### Voice Activity Detection

- Threshold: 0.5 (adjustable sensitivity)
- Max Silence: 2000ms
- Debounce: 300ms

### WebRTC Settings

- ICE Servers: STUN for NAT traversal
- Audio Constraints: Echo/noise suppression
- Target Latency: <100ms

## Customization

Edit `voice-pipeline-example.ts` to:

- Adjust voice settings (Marin/Cedar)
- Modify VAD parameters
- Add custom tools
- Change audio configuration
- Enable/disable WebRTC mode

## Production Considerations

1. **API Keys**: Store securely, never commit to version control
2. **Error Handling**: Implement robust error recovery
3. **Latency**: Use WebRTC for lowest latency requirements
4. **Audio Quality**: Balance quality vs bandwidth based on use case
5. **Rate Limiting**: Monitor API usage and implement appropriate limits

## Troubleshooting

### High Latency

- Enable WebRTC mode for ultra-low latency
- Check network connection quality
- Optimize audio buffer sizes

### Audio Quality Issues

- Adjust VAD threshold for your environment
- Enable noise suppression
- Check microphone quality

### Connection Issues

- Verify API key has necessary permissions
- Check firewall settings for WebRTC
- Ensure stable internet connection

## Related Resources

- [Voice Agents Guide](../../docs/src/content/docs/guides/voice-agents)
- [Realtime API Documentation](https://platform.openai.com/docs/guides/realtime)
- [OpenAI Agents SDK Documentation](../../docs)
