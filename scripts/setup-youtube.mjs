import { createHash } from 'node:crypto';
import { mkdir, writeFile, chmod, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const assets = {
  'win32:x64': 'yt-dlp.exe', 'linux:x64': 'yt-dlp_linux',
  'linux:arm64': 'yt-dlp_linux_aarch64', 'darwin:x64': 'yt-dlp_macos', 'darwin:arm64': 'yt-dlp_macos',
};
const name = assets[`${process.platform}:${process.arch}`];
if (!name) throw new Error('Install yt-dlp for this platform and set YT_DLP_PATH to its executable.');
async function get(url) {
  const response = await fetch(url, { headers: { 'User-Agent': 'melody-tab-setup' }, signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
  return response;
}
const release = await (await get('https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest')).json();
const asset = release.assets.find((entry) => entry.name === name);
const checksum = release.assets.find((entry) => entry.name === 'SHA2-256SUMS');
if (!asset || !checksum) throw new Error('Official release is missing binary or checksums.');
const data = Buffer.from(await (await get(asset.browser_download_url)).arrayBuffer());
const sums = await (await get(checksum.browser_download_url)).text();
const expected = sums.split(/\r?\n/).map((line) => line.trim().split(/\s+/))
  .find((parts) => parts[1] === name)?.[0];
if (!expected || createHash('sha256').update(data).digest('hex') !== expected) throw new Error('yt-dlp checksum mismatch');
const directory = new URL('../.tools/', import.meta.url);
await mkdir(directory, { recursive: true });
const target = fileURLToPath(new URL(process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp', directory));
await writeFile(`${target}.download`, data);
await chmod(`${target}.download`, 0o755);
await rename(`${target}.download`, target);
console.log(`Installed yt-dlp ${release.tag_name} with verified SHA-256: ${target}`);
