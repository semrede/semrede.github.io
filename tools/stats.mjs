/* Visit statistics: the side of it that runs on the organizer's machine.
 *
 *   node tools/stats.mjs key                 make the stats key, once
 *   node tools/stats.mjs probe [n]           do relays accept one-off keys?
 *   node tools/stats.mjs selftest            the schema agrees with itself
 *   node tools/stats.mjs paths               the page list matches the repo
 *   node tools/stats.mjs fetch [--since N]   read beacons, keep them locally
 *   node tools/stats.mjs show [day]          print a day
 *   node tools/stats.mjs publish [day]       send a day to the moderators
 *   node tools/stats.mjs run [--days N]      fetch, then publish the last days
 *
 * A beacon is an ordinary NIP-78 event (kind 30078) signed by a key the
 * browser throws away immediately, p-tagged to the stats key, with its content
 * encrypted to that key with NIP-44. Only this tool can read one.
 *
 * (Gift wraps would have been the obvious choice, but most relays refuse to
 * serve kind 1059 back by its p tag, so the beacons would have been write-only.
 * This shape is accepted and readable on every relay we use.)
 *
 * The key lives at ~/.config/semrede/nostr-stats.nsec and never goes into the
 * repository.
 */
import { SimplePool, useWebSocketImplementation } from 'nostr-tools/pool';
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import * as nip19 from 'nostr-tools/nip19';
import * as nip44 from 'nostr-tools/nip44';
import WebSocket from 'ws';
import fs from 'fs';
import os from 'os';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';

// The relays complain loudly about events they do not want; that is expected
// here and would drown out the output.
class QuietWebSocket extends WebSocket {
  constructor(...args) {
    super(...args);
    this.on('error', () => {});
  }
}
useWebSocketImplementation(QuietWebSocket);

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..');

// The browser config and the schema are the source of truth for both sides.
function loadBrowserFile(relative, global) {
  const src = fs.readFileSync(path.join(repo, relative), 'utf8');
  const sandbox = { window: {}, globalThis: {}, module: undefined };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return sandbox.window[global] || sandbox[global];
}

const cfg = loadBrowserFile('js/nostr-config.js', 'SemRedeConfig');
const S = loadBrowserFile('js/stats-schema.js', 'SemRedeStatsSchema');

const STATS_RELAYS = (cfg.STATS && cfg.STATS.RELAYS) || cfg.RELAYS.slice(0, 2);
const STATS_PUBKEY = cfg.STATS && cfg.STATS.PUBKEY;

const CONFIG_DIR = path.join(os.homedir(), '.config', 'semrede');
const KEY_FILE = path.join(CONFIG_DIR, 'nostr-stats.nsec');
const CACHE_DIR = path.join(CONFIG_DIR, 'stats');

const pool = new SimplePool();

// The same event the browser builds, so the probe measures the real thing.
function beaconEvent(sk, payload) {
  const key = nip44.getConversationKey(sk, STATS_PUBKEY);
  return finalizeEvent({
    kind: S.RUMOR_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['d', S.BEACON_D], ['p', STATS_PUBKEY]],
    content: nip44.encrypt(JSON.stringify(payload), key)
  }, sk);
}

function loadKey() {
  const nsec = fs.readFileSync(KEY_FILE, 'utf8').trim();
  return nip19.decode(nsec).data;
}

// Beacons are addressed to the admin key now; the ones sent before that went to
// the stats key. Both live on this machine, so a run can read either.
function loadAdminKey() {
  const file = path.join(CONFIG_DIR, 'nostr-admin.nsec');
  if (!fs.existsSync(file)) return null;
  return nip19.decode(fs.readFileSync(file, 'utf8').trim()).data;
}

function dayOf(seconds) {
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

function today() {
  return dayOf(Date.now() / 1000);
}

function daysBack(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(dayOf(Date.now() / 1000 - i * 86400));
  return out;
}

function readCache(day) {
  const file = path.join(CACHE_DIR, day + '.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
}

function appendCache(day, rows) {
  fs.mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 });
  const file = path.join(CACHE_DIR, day + '.jsonl');
  const known = new Set(readCache(day).map(r => r.id));
  const fresh = rows.filter(r => !known.has(r.id));
  if (fresh.length) fs.appendFileSync(file, fresh.map(r => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 });
  return fresh.length;
}

// ---- commands ----

function cmdKey() {
  if (fs.existsSync(KEY_FILE)) {
    const pubkey = getPublicKey(loadKey());
    console.log('the stats key already exists at ' + KEY_FILE);
    console.log('STATS PUBKEY  ' + pubkey);
    console.log('npub          ' + nip19.npubEncode(pubkey));
    return;
  }
  const sk = generateSecretKey();
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(KEY_FILE, nip19.nsecEncode(sk) + '\n', { mode: 0o600 });
  const pubkey = getPublicKey(sk);
  console.log('wrote ' + KEY_FILE + ' (keep it, it is the only way to read the beacons)');
  console.log('STATS PUBKEY  ' + pubkey);
  console.log('npub          ' + nip19.npubEncode(pubkey));
  console.log('\nPut the hex pubkey in js/nostr-config.js under STATS.PUBKEY.');
}

function cmdSelftest() {
  let bad = 0;
  S.FIXTURES.good.forEach((p, i) => { if (!S.validate(p)) { bad++; console.log('good fixture ' + i + ' was rejected'); } });
  S.FIXTURES.bad.forEach((p, i) => { if (S.validate(p)) { bad++; console.log('bad fixture ' + i + ' was accepted'); } });
  const built = S.build({ sid: 'a3f91c02', path: '/crypto', ref: 'www.Reddit.com', lang: 'pt-PT', width: 390, seconds: 42, returning: true, engaged: true });
  if (!built || built.ref !== 'reddit.com' || built.lang !== 'pt' || built.screen !== 'phone' || built.secs !== '15-60') {
    bad++; console.log('build() produced ' + JSON.stringify(built));
  }
  console.log(bad ? bad + ' schema problems' : 'schema ok: ' + (S.FIXTURES.good.length + S.FIXTURES.bad.length) + ' fixtures, build() as expected');
  if (bad) process.exitCode = 1;
}

function cmdPaths() {
  const pages = ['/'].concat(fs.readdirSync(repo, { withFileTypes: true })
    .filter(e => e.isDirectory() && fs.existsSync(path.join(repo, e.name, 'index.html')))
    .map(e => '/' + e.name));
  const counted = pages.filter(p => S.SKIP_PATHS.indexOf(p) === -1).sort();
  const listed = S.PATHS.slice().sort();
  const missing = counted.filter(p => listed.indexOf(p) === -1);
  const extra = listed.filter(p => counted.indexOf(p) === -1);
  if (missing.length) console.log('pages in the repo that the schema does not list: ' + missing.join(' '));
  if (extra.length) console.log('paths listed in the schema with no page: ' + extra.join(' '));
  if (!missing.length && !extra.length) console.log('schema paths match the repo: ' + listed.length + ' counted, ' + S.SKIP_PATHS.length + ' never counted');
  else process.exitCode = 1;
}

// Can a brand-new key publish a gift wrap to these relays, and is it still
// there afterwards? This is the question the whole design rests on.
async function cmdProbe(count) {
  const n = Number(count) || 5;
  const recipient = STATS_PUBKEY || getPublicKey(generateSecretKey());
  console.log('probing ' + cfg.RELAYS.length + ' relays with ' + n + ' one-off keys each\n');

  const results = [];
  for (const relay of cfg.RELAYS) {
    const ids = [];
    let accepted = 0, refused = 0;
    const reasons = new Set();
    for (let i = 0; i < n; i++) {
      const sk = generateSecretKey();
      const wrap = beaconEvent(sk, S.FIXTURES.good[0]);
      ids.push(wrap.id);
      try {
        await Promise.any(pool.publish([relay], wrap));
        accepted++;
      } catch (e) {
        refused++;
        const why = (e && e.errors ? e.errors.map(x => x.message).join('; ') : String(e && e.message || e)).slice(0, 90);
        reasons.add(why);
      }
      await new Promise(r => setTimeout(r, 400));
    }

    let kept = 0;
    try {
      const back = await pool.querySync([relay], { kinds: [S.RUMOR_KIND], '#p': [STATS_PUBKEY], limit: 200 }, { maxWait: 6000 });
      const mine = new Set(ids);
      kept = back.filter(e => mine.has(e.id)).length;
    } catch (e) { /* relay unreachable for reads */ }

    results.push({ relay, accepted, refused, kept, reasons: Array.from(reasons) });
    console.log(relay.padEnd(34) + 'accepted ' + accepted + '/' + n + '   readable back ' + kept + '/' + n +
      (reasons.size ? '   ' + Array.from(reasons)[0] : ''));
  }

  const good = results.filter(r => r.accepted === n && r.kept === n).map(r => r.relay);
  console.log('\nrelays that took every one-off key and served it back: ' + (good.length ? good.join(' ') : 'none'));
  if (good.length >= 2) console.log('suggested STATS.RELAYS: ' + JSON.stringify(good.slice(0, 2)));
  else console.log('not enough relays accept throwaway keys; see the README before shipping the beacon');
}

async function cmdFetch(sinceDays) {
  const sk = loadKey();
  const adminSk = loadAdminKey();
  const targets = [];
  if (adminSk) targets.push({ pubkey: cfg.ADMIN_PUBKEY, sk: adminSk });
  if (cfg.STATS.LEGACY_PUBKEY) targets.push({ pubkey: cfg.STATS.LEGACY_PUBKEY, sk: sk });
  if (!targets.length) throw new Error('no key to read beacons with');
  const since = Math.floor(Date.now() / 1000) - (Number(sinceDays) || 2) * 86400;
  console.log('reading beacons addressed to the stats key...');
  const relays = STATS_RELAYS.concat(cfg.RELAYS).filter((u, i, all) => all.indexOf(u) === i);
  const wanted = targets.map(t => t.pubkey);
  const events = await pool.querySync(relays,
    { kinds: [S.RUMOR_KIND], '#p': wanted, '#d': [S.BEACON_D], since, limit: 5000 }, { maxWait: 10000 });
  console.log('got ' + events.length + ' events');

  const dropped = {};
  const byDay = {};
  const authors = new Set();
  const now = Math.floor(Date.now() / 1000);

  for (const ev of events) {
    const drop = (why) => { dropped[why] = (dropped[why] || 0) + 1; };
    if (ev.kind !== S.RUMOR_KIND || !verifyEvent(ev)) { drop('bad signature'); continue; }
    if ((ev.tags.find(t => t[0] === 'd') || [])[1] !== S.BEACON_D) { drop('not a beacon'); continue; }
    const ps = ev.tags.filter(t => t[0] === 'p');
    const target = ps.length === 1 && targets.filter(t => t.pubkey === ps[0][1])[0];
    if (!target) { drop('not for us'); continue; }
    // An honest browser uses its key once and throws it away.
    if (authors.has(ev.pubkey)) { drop('key reused'); continue; }
    authors.add(ev.pubkey);
    if (ev.content.length > S.MAX_BYTES * 3) { drop('too big'); continue; }
    if (ev.created_at > now + 3600 || ev.created_at < now - 30 * 86400) { drop('bad timestamp'); continue; }

    let payload = null;
    try {
      payload = S.validate(JSON.parse(nip44.decrypt(ev.content, nip44.getConversationKey(target.sk, ev.pubkey))));
    } catch (e) { payload = null; }
    if (!payload) { drop('will not decrypt or not a valid payload'); continue; }

    const day = dayOf(ev.created_at);
    (byDay[day] = byDay[day] || []).push({ id: ev.id, at: ev.created_at, p: payload });
  }

  let stored = 0;
  for (const day of Object.keys(byDay)) stored += appendCache(day, byDay[day]);
  console.log('kept ' + stored + ' new beacons across ' + Object.keys(byDay).length + ' days');
  if (Object.keys(dropped).length) console.log('dropped: ' + Object.entries(dropped).map(([k, v]) => k + ' ' + v).join(', '));
}

// The counting rules live in js/stats-schema.js, so the browser and this tool
// cannot disagree about what a visit is.
function aggregate(day) {
  return S.aggregate(day, readCache(day));
}

function cmdShow(day) {
  const which = day || today();
  const a = aggregate(which);
  console.log('\n' + a.day + '   ' + a.views + ' page views, ' + a.visits + ' visits (' + a.firstTime + ' first time here)');
  console.log('from ' + a.beacons + ' beacons' + (a.capped ? ', ' + a.capped + ' capped' : '') + (a.ungrouped ? ', ' + a.ungrouped + ' could not be grouped' : ''));
  for (const [title, table] of [['pages', a.paths], ['came from', a.refs], ['language', a.langs], ['screen', a.screens], ['time on page', a.secs]]) {
    const rows = Object.entries(table).sort((x, y) => y[1] - x[1]);
    if (!rows.length) continue;
    console.log('\n  ' + title);
    rows.forEach(([k, n]) => console.log('    ' + String(k).padEnd(26) + n));
  }
  console.log('');
}

async function cmdPublish(day) {
  const which = day || today();
  const sk = loadKey();
  const data = aggregate(which);
  if (!data.beacons) { console.log('nothing cached for ' + which); return; }

  const mods = await pool.get(cfg.RELAYS, { kinds: [30000], authors: [cfg.ADMIN_PUBKEY], '#d': ['semrede-moderators'] }, { maxWait: 6000 });
  const recipients = [cfg.ADMIN_PUBKEY].concat(
    ((mods && mods.tags) || []).filter(t => t[0] === 'p' && /^[0-9a-f]{64}$/.test(t[1])).map(t => t[1])
  ).filter((pk, i, all) => all.indexOf(pk) === i);

  console.log('sending ' + which + ' to ' + recipients.length + ' people');
  for (const pk of recipients) {
    // Addressable: the day + the reader, so re-running replaces rather than
    // piling up, and /admin can filter on authors:[stats key].
    const ev = finalizeEvent({
      kind: S.RUMOR_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['d', S.AGG_D_PREFIX + which + '-' + pk.slice(0, 8)], ['p', pk], ['title', 'SemRede visits ' + which]],
      content: nip44.encrypt(JSON.stringify(data), nip44.getConversationKey(sk, pk))
    }, sk);
    const results = await Promise.allSettled(pool.publish(cfg.RELAYS, ev));
    const taken = results.filter(r => r.status === 'fulfilled').length;
    console.log('  ' + pk.slice(0, 12) + '...  ' + taken + '/' + cfg.RELAYS.length + ' relays');
  }
}

// Proves the privacy claim rather than asserting it: the beacon is on the
// relays, the stats key reads it, an unrelated key cannot, and the plaintext
// carries nothing it should not.
async function cmdVerify(file) {
  const sk = loadKey();
  const ev = JSON.parse(fs.readFileSync(file, 'utf8'));
  let bad = 0;
  const check = (ok, text) => { console.log((ok ? '  ok    ' : '  FAIL  ') + text); if (!ok) bad++; };

  check(ev.kind === S.RUMOR_KIND && verifyEvent(ev), 'a valid ' + S.RUMOR_KIND + ' event');
  const ps = ev.tags.filter(t => t[0] === 'p');
  check(ps.length === 1 && ps[0][1] === STATS_PUBKEY, 'addressed to the stats key and nobody else');
  check(ev.pubkey !== STATS_PUBKEY && ev.pubkey !== cfg.ADMIN_PUBKEY, 'signed by a throwaway key');

  const back = await pool.querySync(STATS_RELAYS, { ids: [ev.id] }, { maxWait: 8000 });
  check(back.length > 0, 'stored on the relays (' + back.length + ')');

  let payload = null;
  try { payload = JSON.parse(nip44.decrypt(ev.content, nip44.getConversationKey(sk, ev.pubkey))); } catch (e) {}
  check(!!S.validate(payload), 'the stats key reads it: ' + JSON.stringify(payload));

  let stranger = null;
  try { stranger = nip44.decrypt(ev.content, nip44.getConversationKey(generateSecretKey(), ev.pubkey)); } catch (e) {}
  check(stranger === null, 'an unrelated key cannot read it');

  const text = JSON.stringify(payload || {});
  const leaks = [/Mozilla|Chrome|Safari|Firefox/, /\d+\.\d+\.\d+\.\d+/, /https?:\/\/\S*\//];
  check(!leaks.some(re => re.test(text)), 'no user agent, no address, no full link in the payload');

  console.log(bad ? '\n' + bad + ' checks failed' : '\nall checks passed');
  if (bad) process.exitCode = 1;
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === 'key') return cmdKey();
  if (cmd === 'selftest') return cmdSelftest();
  if (cmd === 'paths') return cmdPaths();
  if (cmd === 'probe') return cmdProbe(arg);
  if (cmd === 'fetch') return cmdFetch(process.argv.includes('--since') ? process.argv[process.argv.indexOf('--since') + 1] : 2);
  if (cmd === 'show') return cmdShow(arg);
  if (cmd === 'publish') return cmdPublish(arg);
  if (cmd === 'verify') return cmdVerify(arg);
  if (cmd === 'run') {
    const days = process.argv.includes('--days') ? Number(process.argv[process.argv.indexOf('--days') + 1]) || 2 : 2;
    await cmdFetch(days);
    // Today first, so the card moves during the day, then the days before it,
    // which closes out yesterday after midnight and fills in a machine that
    // was switched off.
    for (const day of daysBack(days)) await cmdPublish(day);
    return;
  }
  console.log('usage: node tools/stats.mjs key | probe [n] | selftest | paths | fetch [--since N] | show [day] | publish [day] | verify <file> | run');
}

main().then(() => { pool.close(cfg.RELAYS.concat(STATS_RELAYS)); process.exit(process.exitCode || 0); },
  e => { console.error(e.message); process.exit(1); });
