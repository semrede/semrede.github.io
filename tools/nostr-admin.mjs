// SemRede chat admin tool.
//   node nostr-admin.mjs create            generate (or reuse) the admin key, publish its profile and the chat room
//   node nostr-admin.mjs mute <npub|hex>   hide a user's messages on semrede.com (NIP-51 mute list)
//   node nostr-admin.mjs unmute <npub|hex>
//   node nostr-admin.mjs calendar         publish the two calendar events people RSVP to
//   node nostr-admin.mjs sync <channel id> copy the room and admin events onto every relay
//   node nostr-admin.mjs list              show the current mute list
// The admin secret key is read from ~/.config/semrede/nostr-admin.nsec (never commit it).
import { SimplePool, useWebSocketImplementation } from 'nostr-tools/pool';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import * as nip19 from 'nostr-tools/nip19';
import WebSocket from 'ws';
import fs from 'fs';
import os from 'os';
import path from 'path';

// A dead relay must not crash the tool: swallow socket errors, the pool reports failures itself.
class QuietWebSocket extends WebSocket {
  constructor(...args) { super(...args); this.on('error', () => {}); }
}
useWebSocketImplementation(QuietWebSocket);

const RELAYS = ['wss://relay.primal.net', 'wss://relay.damus.io', 'wss://relay.snort.social', 'wss://nostr-pub.wellorder.net', 'wss://purplerelay.com', 'wss://relay.piazza.today'];
const KEY_FILE = path.join(os.homedir(), '.config', 'semrede', 'nostr-admin.nsec');
const SITE = 'https://semrede.com';

const pool = new SimplePool();

function loadKey() {
  const nsec = fs.readFileSync(KEY_FILE, 'utf8').trim();
  return nip19.decode(nsec).data;
}

function toHex(key) {
  return key.startsWith('npub') ? nip19.decode(key).data : key;
}

async function publish(template, sk) {
  const event = finalizeEvent({ created_at: Math.floor(Date.now() / 1000), ...template }, sk);
  const results = await Promise.allSettled(pool.publish(RELAYS, event));
  const ok = results.filter(r => r.status === 'fulfilled').length;
  console.log(`kind ${event.kind} ${event.id} accepted by ${ok}/${RELAYS.length} relays`);
  if (!ok) throw new Error('no relay accepted the event');
  return event;
}

async function currentMutes(pk) {
  const ev = await pool.get(RELAYS, { kinds: [10000], authors: [pk] });
  return ev ? ev.tags : [];
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === 'create') {
    let sk;
    if (fs.existsSync(KEY_FILE)) {
      sk = loadKey();
      console.log('reusing existing admin key from', KEY_FILE);
    } else {
      sk = generateSecretKey();
      fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true, mode: 0o700 });
      fs.writeFileSync(KEY_FILE, nip19.nsecEncode(sk) + '\n', { mode: 0o600 });
    }
    const pk = getPublicKey(sk);
    await publish({
      kind: 0, tags: [],
      content: JSON.stringify({
        name: 'SemRede', display_name: 'SemRede',
        about: 'Offgrid communications, communities & people. Coimbra, Portugal.',
        picture: SITE + '/img/logo.png', website: SITE,
      }),
    }, sk);
    const room = await publish({
      kind: 40, tags: [],
      content: JSON.stringify({
        name: 'SemRede 2026',
        about: 'Offgrid communications, communities & people. Coimbra, October 19 to 24, 2026.',
        picture: SITE + '/img/logo.png',
        relays: RELAYS,
      }),
    }, sk);
    await publish({ kind: 10000, tags: [], content: '' }, sk);
    console.log('\nADMIN_PUBKEY =', pk, '(' + nip19.npubEncode(pk) + ')');
    console.log('CHANNEL_ID   =', room.id);
    console.log('secret key saved to', KEY_FILE);
  } else if (cmd === 'mute' || cmd === 'unmute') {
    if (!arg) throw new Error('usage: ' + cmd + ' <npub|hex>');
    const sk = loadKey(); const pk = getPublicKey(sk); const target = toHex(arg);
    let tags = (await currentMutes(pk)).filter(t => !(t[0] === 'p' && t[1] === target));
    if (cmd === 'mute') tags.push(['p', target]);
    await publish({ kind: 10000, tags, content: '' }, sk);
    console.log(cmd + 'd', target, '- mute list now has', tags.filter(t => t[0] === 'p').length, 'entries');
  } else if (cmd === 'calendar') {
    // Two NIP-52 date-based calendar events (kind 31922). People RSVP to these
    // from /registration, and the counters are the RSVPs.
    const sk = loadKey();
    const parts = [
      { d: 'semrede-2026-eva', title: 'SemRede 2026: the week at Eva Farm',
        start: '2026-10-19', end: '2026-10-24',
        location: 'Eva Farm, Coimbra, Portugal',
        summary: 'Five days of hands-on sessions, talks and community time at Eva Farm. Free, registration helps us plan.' },
      { d: 'semrede-2026-embaixada', title: 'SemRede 2026: open day at Edificio Embaixada',
        start: '2026-10-24', end: '2026-10-25',
        location: 'Edificio Embaixada, Coimbra, Portugal',
        summary: 'One open day in the centre of Coimbra: talks, demos, community fair and celebration. Free, registration helps us plan.' },
    ];
    for (const p of parts) {
      const ev = await publish({
        kind: 31922,
        tags: [
          ['d', p.d], ['title', p.title], ['start', p.start], ['end', p.end],
          ['location', p.location], ['summary', p.summary],
          ['t', 'semrede'], ['r', SITE],
        ],
        content: p.summary,
      }, sk);
      console.log(p.d, '->', '31922:' + getPublicKey(sk) + ':' + p.d, '(event ' + ev.id.slice(0, 12) + ')');
    }
  } else if (cmd === 'sync') {
    // Copy the room and the admin's own events onto every relay in RELAYS (never creates a new room).
    if (!arg) throw new Error('usage: sync <channel id>');
    const pk = getPublicKey(loadKey());
    const events = await pool.querySync(RELAYS, { ids: [arg] });
    const mine = await pool.querySync(RELAYS, { kinds: [0, 10000], authors: [pk] });
    const newest = new Map();
    for (const ev of [...events, ...mine]) {
      const key = ev.kind === 40 ? ev.id : ev.kind;
      if (!newest.has(key) || newest.get(key).created_at < ev.created_at) newest.set(key, ev);
    }
    for (const ev of newest.values()) {
      const results = await Promise.allSettled(pool.publish(RELAYS, ev));
      console.log('kind', ev.kind, 'on', results.filter(r => r.status === 'fulfilled').length + '/' + RELAYS.length, 'relays');
    }
  } else if (cmd === 'list') {
    const pk = getPublicKey(loadKey());
    for (const t of await currentMutes(pk)) if (t[0] === 'p') console.log(nip19.npubEncode(t[1]));
  } else {
    console.log('usage: node nostr-admin.mjs create | calendar | mute <npub|hex> | unmute <npub|hex> | sync <channel id> | list');
  }
}

main().then(() => { pool.close(RELAYS); process.exit(0); }, e => { console.error(e.message); process.exit(1); });
