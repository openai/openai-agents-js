import { session } from './agent';

session.interrupt();
// This still triggers `audio_interrupted` so your UI can stop playback
