/* One encrypted beacon per page view, so the organizers know whether any of
 * this is being read.
 *
 * What leaves the browser is a NIP-78 event (kind 30078) signed with a key
 * made and thrown away on the spot, carrying nothing but the fields listed in
 * js/stats-schema.js, encrypted to the SemRede stats key. Two beacons from the
 * same person cannot be tied together by anyone, including the relay, which
 * does see the IP address the way any server would.
 *
 * Nothing is sent when Do Not Track or Global Privacy Control is on, when the
 * switch on /privacy says no, when this browser cannot remember that choice,
 * or when the page was never actually looked at.
 */
(function () {
  'use strict';

  var cfg = window.SemRedeConfig;
  var S = window.SemRedeStatsSchema;
  if (!cfg || !S || !cfg.STATS || cfg.STATS.ENABLED !== true) return;

  var OFF_KEY = 'semrede_stats_off';
  var SEEN_KEY = 'semrede_stats_seen';
  var SID_KEY = 'semrede_stats_sid';
  var OUTBOX_KEY = 'semrede_stats_outbox';
  var BUNDLE = '/js/vendor/nostr.bundle.js';

  // A local run is for testing the page, not for counting.
  var local = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  var test = local && /[?&]stats-test=(1|force)/.test(location.search);
  var force = local && /[?&]stats-test=force/.test(location.search);

  function stored(key) {
    try { return localStorage.getItem(key); } catch (e) { return undefined; }
  }

  function remember(key, value) {
    try { localStorage.setItem(key, value); return true; } catch (e) { return false; }
  }

  // ---- should anything be sent at all ----

  var dnt = navigator.doNotTrack === '1' || window.doNotTrack === '1' ||
    navigator.msDoNotTrack === '1' || navigator.globalPrivacyControl === true;

  // If the browser cannot keep an opt-out, we do not count. Saying no has to
  // stick, and here it cannot.
  var canRemember = (function () {
    try {
      localStorage.setItem(SEEN_KEY + '_probe', '1');
      localStorage.removeItem(SEEN_KEY + '_probe');
      return true;
    } catch (e) { return false; }
  })();

  var path = location.pathname.replace(/index\.html$/, '').replace(/(.)\/$/, '$1');
  if (path === '') path = '/';

  var blocked =
    (dnt && !force) ||
    !canRemember ||
    stored(OFF_KEY) ||
    navigator.webdriver && !test ||
    (!local && location.hostname !== 'semrede.com') ||
    (local && !test) ||
    S.SKIP_PATHS.indexOf(path) !== -1 ||
    S.PATHS.indexOf(path) === -1 ||
    document.prerendering ||
    Math.random() >= (cfg.STATS.SAMPLE || 1);

  // The switch on /privacy is wired even when nothing is being counted, so it
  // can say what is going on.
  wireSwitch();
  if (blocked) return;

  // ---- what this page view looked like ----

  var sid = (function () {
    try {
      var existing = sessionStorage.getItem(SID_KEY);
      if (existing) return existing;
      var bytes = new Uint8Array(4);
      crypto.getRandomValues(bytes);
      var value = Array.from(bytes).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
      sessionStorage.setItem(SID_KEY, value);
      return value;
    } catch (e) {
      // No session storage: this page view cannot be grouped into a visit, and
      // the "v" says so, rather than quietly inflating the numbers.
      var solo = new Uint8Array(3);
      crypto.getRandomValues(solo);
      return 'v' + Array.from(solo).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
    }
  })();

  var today = new Date().toISOString().slice(0, 10);
  var lastSeen = stored(SEEN_KEY);
  var returning = !!lastSeen && lastSeen !== today;

  var referrer = '';
  try {
    if (document.referrer) {
      var host = new URL(document.referrer).hostname;
      if (host && host !== location.hostname) referrer = host;
    }
  } catch (e) { referrer = ''; }

  var engaged = false;
  ['pointerdown', 'keydown', 'scroll', 'touchstart'].forEach(function (name) {
    window.addEventListener(name, function () { engaged = true; }, { once: true, passive: true });
  });

  // Seconds the page was actually in front of somebody, not seconds since load.
  var visibleSince = document.visibilityState === 'visible' ? Date.now() : 0;
  var visibleMs = 0;
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') {
      visibleSince = Date.now();
      flushOutbox();
    } else {
      if (visibleSince) visibleMs += Date.now() - visibleSince;
      visibleSince = 0;
      send();
    }
  });

  // ---- the library and the socket, both got ready while the page is idle ----
  //
  // The socket has to be connected BEFORE somebody leaves. Opening one during
  // pagehide is a handshake against a page that is being torn down, and it
  // almost never finishes, which is how most beacons used to get lost.

  var tools = null;
  var loading = false;
  var socket = null;
  var relayIndex = 0;

  function loadTools(done) {
    if (window.NostrTools) { tools = window.NostrTools; return done(); }
    if (loading) return;
    loading = true;
    var script = document.createElement('script');
    script.src = BUNDLE;
    script.async = true;
    script.addEventListener('load', function () { tools = window.NostrTools; done(); });
    script.addEventListener('error', function () { loading = false; });
    document.head.appendChild(script);
  }

  function connect() {
    var relays = cfg.STATS.RELAYS || [];
    if (socket || relayIndex >= relays.length) return;
    var url = relays[relayIndex++];
    try { socket = new WebSocket(url); } catch (e) { socket = null; return connect(); }
    socket.addEventListener('open', function () { flushOutbox(); });
    socket.addEventListener('close', function () { socket = null; });
    socket.addEventListener('error', function () {
      socket = null;
      connect();               // the second relay, if the first will not have us
    });
  }

  var idle = window.requestIdleCallback || function (fn) { return setTimeout(fn, 2000); };
  window.addEventListener('load', function () {
    idle(function () { loadTools(connect); });
  });

  // ---- the outbox ----
  //
  // A beacon that could not be pushed is kept here and goes out with the next
  // page view. Re-sending is harmless: an event id is a hash of the event, so
  // the relay drops the duplicate and the aggregator counts it once.

  function readOutbox() {
    var raw = stored(OUTBOX_KEY);
    if (!raw) return [];
    var list;
    try { list = JSON.parse(raw); } catch (e) { return []; }
    if (!Array.isArray(list)) return [];
    var cutoff = Date.now() - 48 * 3600 * 1000;
    return list.filter(function (row) {
      return row && row.event && row.at > cutoff && (row.tries || 0) < 3;
    }).slice(-5);
  }

  function writeOutbox(list) {
    if (!list.length) {
      try { localStorage.removeItem(OUTBOX_KEY); } catch (e) {}
      return;
    }
    remember(OUTBOX_KEY, JSON.stringify(list.slice(-5)));
  }

  function queue(event) {
    var list = readOutbox();
    if (list.some(function (row) { return row.event && row.event.id === event.id; })) return;
    list.push({ event: event, at: Date.now(), tries: 0 });
    writeOutbox(list);
  }

  function flushOutbox() {
    if (!socket || socket.readyState !== 1) return;
    var list = readOutbox();
    if (!list.length) return;
    var left = [];
    list.forEach(function (row) {
      if (!push(row.event)) {
        row.tries = (row.tries || 0) + 1;
        left.push(row);
      }
    });
    writeOutbox(left);
  }

  // ---- sending ----

  var sent = false;

  function send() {
    if (sent || !tools) return;
    var seconds = Math.round((visibleMs + (visibleSince ? Date.now() - visibleSince : 0)) / 1000);
    if (seconds < 1) return;   // never looked at

    var payload = S.build({
      sid: sid, path: path, ref: referrer, lang: navigator.language,
      width: window.innerWidth, seconds: seconds, returning: returning, engaged: engaged
    });
    if (!payload) return;

    var event;
    try {
      var sk = tools.generateSecretKey();
      var key = tools.nip44.getConversationKey(sk, cfg.STATS.PUBKEY);
      event = tools.finalizeEvent({
        kind: S.RUMOR_KIND,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['d', S.BEACON_D], ['p', cfg.STATS.PUBKEY]],
        content: tools.nip44.encrypt(JSON.stringify(payload), key)
      }, sk);
    } catch (e) { return; }

    sent = true;
    remember(SEEN_KEY, today);
    if (!push(event)) queue(event);
  }

  // One frame down the socket that is already open. No waiting for the answer:
  // the page is going away, and the outbox covers what does not land.
  function push(event) {
    if (!socket || socket.readyState !== 1) return false;
    try {
      socket.send(JSON.stringify(['EVENT', event]));
      return true;
    } catch (e) {
      return false;
    }
  }

  window.addEventListener('pagehide', send);

  // ---- the switch on /privacy ----

  function wireSwitch() {
    var button = document.getElementById('stats-switch');
    var note = document.getElementById('stats-switch-note');
    if (!button) return;

    function draw() {
      var off = !!stored(OFF_KEY);
      button.textContent = off ? 'Count my visits' : 'Do not count my visits';
      button.setAttribute('aria-pressed', off ? 'false' : 'true');
      if (!note) return;
      if (dnt) note.textContent = 'Your browser already asks not to be tracked, so nothing is counted here.';
      else if (!canRemember) note.textContent = 'This browser is not keeping anything, so nothing is counted here.';
      else note.textContent = off ? 'Nothing is counted in this browser.' : 'Kept in this browser only. Clear your browser data and it comes back.';
    }

    button.addEventListener('click', function () {
      if (stored(OFF_KEY)) {
        try { localStorage.removeItem(OFF_KEY); } catch (e) {}
      } else {
        remember(OFF_KEY, '1');
      }
      draw();
    });

    draw();
  }
})();
