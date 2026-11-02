// Exercise the actual app download path. Start npm run dev first.
const url = process.argv[2] || 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
try {
  const response = await fetch(`http://127.0.0.1:5173/api/youtube?url=${encodeURIComponent(url)}`, {
    signal: AbortSignal.timeout(70000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  if (!response.headers.get('content-type')?.startsWith('audio/')) throw new Error('Expected audio response');
  const bytes = (await response.arrayBuffer()).byteLength;
  if (!bytes || bytes !== Number(response.headers.get('content-length'))) throw new Error('Incomplete audio');
  console.log(`OK — ${decodeURIComponent(response.headers.get('x-video-title'))}, ${bytes} bytes`);
} catch (error) {
  console.error(`FAIL — ${error.message}`);
  process.exitCode = 1;
}
