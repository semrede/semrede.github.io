/* Copies the music itself into the site, so the player streams from
 * semrede.com and nobody's browser has to talk to Fountain.
 *
 *   node tools/audio.mjs
 *
 * The Fountain feeds carry lossless WAV (about 40 MB a track), which is far
 * too much to serve: each one is re-encoded to AAC at 112 kbps in an .m4a,
 * which every browser plays, and the original URL is kept in the data file
 * under "fountain" so the link back to the artist never gets lost.
 *
 * Tracks already converted are skipped, so the tool can be re-run after
 * tools/music.mjs picks up a new release.
 */
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';

const BITRATE = '112k';
const root = path.resolve(import.meta.dirname, '..');
const dataFile = path.join(root, 'js', 'music-data.js');
const outDir = path.join(root, 'files', 'music');

let data = await fs.readFile(dataFile, 'utf8');
await fs.mkdir(outDir, { recursive: true });

// Each track is an object in the data file; work from the remote urls still in it.
const remote = [...new Set([...data.matchAll(/"url": "(https:[^"]+)"/g)].map(m => m[1]))];
console.log(remote.length + ' tracks still coming from Fountain');

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', d => { err += d; });
    p.on('close', code => code === 0 ? resolve() : reject(new Error(cmd + ' failed: ' + err.slice(-400))));
  });
}

let done = 0;
for (const url of remote) {
  const name = crypto.createHash('sha1').update(url).digest('hex').slice(0, 12) + '.m4a';
  const out = path.join(outDir, name);
  let have = true;
  try { await fs.access(out); } catch { have = false; }

  if (!have) {
    const tmp = path.join(os.tmpdir(), 'semrede-' + name + '.src');
    const res = await fetch(url);
    if (!res.ok) { console.log('skipped ' + res.status, url); continue; }
    await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
    await run('ffmpeg', ['-v', 'error', '-y', '-i', tmp, '-vn', '-c:a', 'aac', '-b:a', BITRATE,
      '-movflags', '+faststart', out]);
    await fs.rm(tmp, { force: true });
    const size = (await fs.stat(out)).size;
    console.log(name, Math.round(size / 1024) + ' KB');
  }

  // point the data file at our own copy, keeping the Fountain url beside it
  data = data.split('"url": "' + url + '"').join('"url": "/files/music/' + name + '",\n      "fountain": "' + url + '"');
  done++;
}

data = data.replace(/"type": "audio\/wav"/g, '"type": "audio/mp4"');
await fs.writeFile(dataFile, data);
console.log(done + ' tracks now served from /files/music/');
