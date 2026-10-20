// Copy the basic-pitch tfjs model out of node_modules so the dev server can serve it.
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'node_modules', '@spotify', 'basic-pitch', 'model');
const dest = join(root, 'public', 'model');

if (!existsSync(src)) {
  console.error('basic-pitch model not found at', src);
  process.exit(1);
}
mkdirSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true });
console.log('Copied basic-pitch model to public/model');
