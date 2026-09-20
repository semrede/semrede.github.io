/* Downloads the web fonts once and writes css/fonts.css, so the site serves
 * them itself and nobody's browser has to call Google to read the pages.
 *
 *   node tools/fonts.mjs
 *
 * Keeps the latin and latin-ext subsets (enough for English and Portuguese)
 * and drops the rest.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const URL = 'https://fonts.googleapis.com/css2?family=Barlow+Condensed:ital,wght@0,400;0,600;0,700;0,800;1,700;1,800;1,900&family=Kalam:wght@400;700&family=Space+Mono:wght@400;700&display=swap';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const KEEP = ['latin', 'latin-ext'];
const root = path.resolve(import.meta.dirname, '..');

const css = await (await fetch(URL, { headers: { 'User-Agent': UA } })).text();

// The stylesheet is a list of @font-face blocks, each preceded by a comment
// naming its subset.
const blocks = [];
const re = /\/\*\s*([a-z-]+)\s*\*\/\s*(@font-face\s*\{[^}]*\})/g;
let m;
while ((m = re.exec(css))) blocks.push({ subset: m[1], text: m[2] });

await fs.mkdir(path.join(root, 'fonts'), { recursive: true });
const out = ['/* Self-hosted web fonts. Rebuilt with tools/fonts.mjs. */'];
let kept = 0;

for (const block of blocks) {
  if (!KEEP.includes(block.subset)) continue;
  const family = /font-family:\s*'([^']+)'/.exec(block.text)[1];
  const weight = /font-weight:\s*(\d+)/.exec(block.text)[1];
  const style = /font-style:\s*(\w+)/.exec(block.text)[1];
  const url = /url\((https:[^)]+\.woff2)\)/.exec(block.text)[1];
  const name = [family.toLowerCase().replace(/\s+/g, '-'), weight, style, block.subset].join('-') + '.woff2';

  const data = Buffer.from(await (await fetch(url, { headers: { 'User-Agent': UA } })).arrayBuffer());
  await fs.writeFile(path.join(root, 'fonts', name), data);
  out.push(block.text.replace(url, '/fonts/' + name).replace(/\n\s*/g, '\n  ').trim());
  kept++;
  console.log(name, data.length + ' bytes');
}

await fs.writeFile(path.join(root, 'css', 'fonts.css'), out.join('\n\n') + '\n');
console.log(kept + ' faces written to css/fonts.css');
