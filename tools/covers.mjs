/* Pulls the album covers out of Fountain and stores them in img/music/, then
 * points js/music-data.js at the local copies.
 *
 *   node tools/covers.mjs
 *
 * The audio is still streamed from Fountain (that is how the artist gets the
 * play), but nothing is fetched from there while somebody is only reading the
 * page.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const root = path.resolve(import.meta.dirname, '..');
const dataFile = path.join(root, 'js', 'music-data.js');
let data = await fs.readFile(dataFile, 'utf8');

const remote = [...new Set([...data.matchAll(/"cover": "(https:[^"]+)"/g)].map(m => m[1]))];
await fs.mkdir(path.join(root, 'img', 'music'), { recursive: true });
console.log(remote.length + ' covers');

for (const url of remote) {
  const ext = (url.match(/\.(jpe?g|png|webp)(\?|$)/i) || [null, 'jpg'])[1].toLowerCase().replace('jpeg', 'jpg');
  const name = crypto.createHash('sha1').update(url).digest('hex').slice(0, 12) + '.' + ext;
  const file = path.join(root, 'img', 'music', name);
  try {
    await fs.access(file);
  } catch {
    const res = await fetch(url);
    if (!res.ok) { console.log('skipped ' + res.status, url); continue; }
    await fs.writeFile(file, Buffer.from(await res.arrayBuffer()));
    console.log(name, url.slice(0, 60) + '...');
  }
  data = data.split('"' + url + '"').join('"/img/music/' + name + '"');
}

await fs.writeFile(dataFile, data);
console.log('js/music-data.js now points at img/music/');
