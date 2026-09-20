/* What a visit beacon may contain, and nothing else.
 *
 * This file is run by the browser (js/stats.js) and by the node tool
 * (tools/stats.mjs), so the two cannot drift: the browser refuses to send
 * anything the tool would throw away, and the tool throws away anything the
 * browser would not have built.
 *
 * The payload is deliberately tiny and every field is a value out of a fixed
 * list, so a beacon cannot carry anything that identifies a person, not even
 * by accident.
 *
 *   { v, sid, path, ref, lang, screen, ret, secs, eng }
 *
 * There is no date in here: the day is taken from the event's own created_at,
 * in UTC, so nobody's timezone leaks.
 */
(function (root) {
  'use strict';

  var S = {
    VERSION: 1,
    RUMOR_KIND: 30078,
    BEACON_D: 'semrede-visit',
    AGG_D_PREFIX: 'semrede-stats-',
    MAX_BYTES: 512,

    // The pages that send a beacon. /login, /messages and /admin never do:
    // counting those would tell the stats key when somebody opened their own
    // inbox, which is nobody's business.
    PATHS: ['/', '/chat', '/crypto', '/forum', '/locations', '/privacy',
            '/registration', '/schedule', '/share', '/showcase'],

    SKIP_PATHS: ['/login', '/messages', '/admin'],

    SCREENS: ['phone', 'tablet', 'desktop'],
    SECS: ['0-5', '5-15', '15-60', '60-180', '180+'],

    // Anything outside this list is reported as "other", so a rare language
    // cannot single somebody out.
    LANGS: ['en', 'pt', 'es', 'fr', 'de', 'it', 'nl', 'pl', 'ru', 'uk', 'cs',
            'sv', 'no', 'da', 'fi', 'el', 'tr', 'ro', 'hu', 'bg', 'hr', 'sr',
            'sk', 'sl', 'et', 'lv', 'lt', 'ga', 'ca', 'gl', 'eu', 'is', 'he',
            'ar', 'fa', 'hi', 'zh', 'ja', 'ko', 'th', 'vi', 'id', 'ms', 'other'],

    REF_RE: /^[a-z0-9-]+(\.[a-z0-9-]+)+$/,
    SID_RE: /^(?:[0-9a-f]{8}|v[0-9a-f]{6})$/,

    // NIP-13 proof of work on the wrap. Off; raise it only if the beacon key
    // is ever flooded (see the README).
    MIN_POW: 0,

    KEYS: ['v', 'sid', 'path', 'ref', 'lang', 'screen', 'ret', 'secs', 'eng']
  };

  function inList(list, value) {
    return list.indexOf(value) !== -1;
  }

  // Returns null when the payload is not something we would ever send.
  S.validate = function (p) {
    if (!p || typeof p !== 'object') return null;
    var keys = Object.keys(p);
    if (keys.length !== S.KEYS.length) return null;
    for (var i = 0; i < keys.length; i++) if (!inList(S.KEYS, keys[i])) return null;

    if (p.v !== S.VERSION) return null;
    if (typeof p.sid !== 'string' || !S.SID_RE.test(p.sid)) return null;
    if (!inList(S.PATHS, p.path)) return null;
    if (typeof p.ref !== 'string' || (p.ref !== '' && !S.REF_RE.test(p.ref)) || p.ref.length > 64) return null;
    if (!inList(S.LANGS, p.lang)) return null;
    if (!inList(S.SCREENS, p.screen)) return null;
    if (p.ret !== 0 && p.ret !== 1) return null;
    if (!inList(S.SECS, p.secs)) return null;
    if (p.eng !== 0 && p.eng !== 1) return null;
    return p;
  };

  // Tidies raw browser values into the shape above.
  S.build = function (raw) {
    var lang = String(raw.lang || '').toLowerCase().split('-')[0];
    var width = Number(raw.width) || 0;
    var seconds = Number(raw.seconds) || 0;
    var ref = String(raw.ref || '').toLowerCase().replace(/^www\./, '');

    return S.validate({
      v: S.VERSION,
      sid: String(raw.sid || ''),
      path: String(raw.path || ''),
      ref: S.REF_RE.test(ref) ? ref.slice(0, 64) : '',
      lang: inList(S.LANGS, lang) ? lang : 'other',
      screen: width < 600 ? 'phone' : (width < 1024 ? 'tablet' : 'desktop'),
      ret: raw.returning ? 1 : 0,
      secs: seconds < 5 ? '0-5' : seconds < 15 ? '5-15' : seconds < 60 ? '15-60' : seconds < 180 ? '60-180' : '180+',
      eng: raw.engaged ? 1 : 0
    });
  };

  // Used by `node tools/stats.mjs selftest`, so a change to this file that
  // breaks one side is caught before it ships.
  S.FIXTURES = {
    good: [
      { v: 1, sid: 'a3f91c02', path: '/schedule', ref: 'duckduckgo.com', lang: 'pt', screen: 'phone', ret: 0, secs: '15-60', eng: 1 },
      { v: 1, sid: 'v1b2c3d', path: '/', ref: '', lang: 'other', screen: 'desktop', ret: 1, secs: '180+', eng: 0 }
    ],
    bad: [
      { v: 2, sid: 'a3f91c02', path: '/', ref: '', lang: 'pt', screen: 'phone', ret: 0, secs: '0-5', eng: 0 },
      { v: 1, sid: 'a3f91c02', path: '/messages', ref: '', lang: 'pt', screen: 'phone', ret: 0, secs: '0-5', eng: 0 },
      { v: 1, sid: 'a3f91c02', path: '/', ref: 'https://reddit.com/r/x', lang: 'pt', screen: 'phone', ret: 0, secs: '0-5', eng: 0 },
      { v: 1, sid: 'a3f91c02', path: '/', ref: '', lang: 'pt', screen: 'phone', ret: 0, secs: '0-5', eng: 0, ua: 'Mozilla/5.0' },
      { v: 1, sid: 'nope!', path: '/', ref: '', lang: 'pt', screen: 'phone', ret: 0, secs: '0-5', eng: 0 }
    ]
  };

  root.SemRedeStatsSchema = S;
  if (typeof module !== 'undefined' && module.exports) module.exports = S;
})(typeof globalThis !== 'undefined' ? globalThis : this);
