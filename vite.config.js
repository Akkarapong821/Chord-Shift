import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { youtubeAudioPlugin } from './server/youtube.js';

export default defineConfig({
  base: './',
  server: {
    port: 5173,
  },
  build: {
    rollupOptions: {
      // Two independent pages: Melody Tab and Chord Shift.
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        chords: fileURLToPath(new URL('./chords.html', import.meta.url)),
      },
    },
  },
  plugins: [youtubeAudioPlugin()],
});
