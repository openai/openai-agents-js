import { session } from './agent';

session.on('audio_interrupted', () => {
  // handle local playback interruption
});
