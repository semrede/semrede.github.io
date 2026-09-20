// Rebuilds js/music-data.js from Haleen's Fountain feeds.
//   node tools/music.mjs
// The publisher feed lists one album feed per release; each album feed carries
// the audio file. Only the metadata is copied here: the audio itself is always
// streamed from Fountain, so plays and bandwidth stay with the artist.
import fs from 'fs';
import path from 'path';

const PUBLISHER = 'https://feeds.fountain.fm/VUDmJJ8Eo1byHznQtHIn';
const ARTIST_PAGE = 'https://fountain.fm/artist/o4G8mlecYblN9FSIxaiI';

const text = (xml, tag) => {
  const m = new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)</' + tag + '>').exec(xml);
  return m ? m[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() : '';
};
const attr = (xml, tag, name) => {
  const m = new RegExp('<' + tag + '[^>]*\\s' + name + '="([^"]*)"').exec(xml);
  return m ? m[1] : '';
};

const feed = await (await fetch(PUBLISHER)).text();
const albums = [...feed.matchAll(/<podcast:remoteItem[^>]*feedUrl="([^"]+)"[^>]*title="([^"]*)"/g)]
  .map(m => ({ url: m[1], title: m[2].replace(/&amp;/g, '&') }));

const tracks = [];
for (const album of albums) {
  try {
    const xml = await (await fetch(album.url)).text();
    const cover = attr(xml, 'itunes:image', 'href');
    for (const item of xml.split('<item>').slice(1)) {
      const url = attr(item, 'enclosure', 'url');
      if (!url) continue;
      tracks.push({
        title: text(item, 'title') || album.title,
        album: album.title,
        url,
        type: attr(item, 'enclosure', 'type') || 'audio/wav',
        duration: Number(text(item, 'itunes:duration')) || 0,
        cover: attr(item, 'itunes:image', 'href') || cover,
      });
    }
    process.stderr.write('.');
  } catch (e) {
    process.stderr.write('!');
  }
}
process.stderr.write('\n');

const out = `/* Haleen's tracks, taken from the Fountain feeds with tools/music.mjs.
 * Only the metadata lives here: the audio is streamed from Fountain, so the
 * plays and the bandwidth stay with the artist.
 * Generated ${new Date().toISOString().slice(0, 10)}, ${tracks.length} tracks.
 */
window.SemRedeMusic = {
  artist: 'Haleen',
  page: '${ARTIST_PAGE}',
  feed: '${PUBLISHER}',
  tracks: ${JSON.stringify(tracks, null, 2).replace(/\n/g, '\n  ')}
};
`;
fs.writeFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'js', 'music-data.js'), out);
console.log('js/music-data.js:', tracks.length, 'tracks from', albums.length, 'albums');
