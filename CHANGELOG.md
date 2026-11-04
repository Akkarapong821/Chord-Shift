# Changelog

## 1.0.0 — 2026-11-04

First stable release of Melody Tab + Chord Shift.

- Chord Shift: read chord sheets with local OCR, transpose keys, view chord diagrams and fretboard scales, and save recent songs.
- Melody Tab: transcribe uploaded audio to guitar tablature with local Basic Pitch inference, selectable time ranges, guitar range/fret settings, and playback.
- Capture audio from a browser tab or download YouTube audio through the local helper.
- Optional Demucs separation: listen to guitar, drums, or both; download the selected mix as WAV and reuse cached stems.
- Windows Home Server: start and stop the local helper from its control window; open the website when requested.
- Mobile browsers use Chord Shift; Melody Tab is available on desktop.
- Distribute versioned Windows/Node.js, static web, and npm tarball packages with SHA-256 checksums.

### Requirements and limitations

- Node.js 22 or newer for the Node.js package. The Windows launcher installs dependencies and yt-dlp on first use, so it needs internet access.
- Guitar/drum separation requires the separate `npm run setup:guitar` installation. Python, FFmpeg, Demucs weights, and local caches are not bundled.
- The static web package includes the Basic Pitch model and OCR assets. Serve it over HTTP(S); YouTube download and stem separation need the local helper or a configured Node.js server.
- The npm tarball is for extraction and local use; this private application is not published to the npm registry.
