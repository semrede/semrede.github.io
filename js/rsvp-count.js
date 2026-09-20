/* Registration counter for pages that do not load the NOSTR library.
 * It opens a relay socket, asks for the RSVPs (kind 31925) of the two calendar
 * events and counts them. Signatures are not checked here: this is a headline
 * number, and the real list is on /registration.
 */
(function () {
  'use strict';

  var cfg = window.SemRedeConfig;
  var box = document.querySelector('[data-rsvp-count]');
  if (!cfg || !box) return;

  var coords = cfg.EVENTS.map(function (e) { return e.coord; });
  var bySlug = {};
  coords.forEach(function (c, i) { bySlug[c] = cfg.EVENTS[i].slug; });

  var latest = new Map();   // pubkey|slug -> {status, created_at}
  var done = false;

  function tagValue(ev, name) {
    for (var i = 0; i < ev.tags.length; i++) if (ev.tags[i][0] === name) return ev.tags[i][1];
    return '';
  }

  function note(ev) {
    var slug = bySlug[tagValue(ev, 'a')];
    var status = tagValue(ev, 'status');
    if (!slug || !status) return;
    var key = ev.pubkey + '|' + slug;
    var old = latest.get(key);
    if (old && old.created_at >= ev.created_at) return;
    latest.set(key, { status: status, created_at: ev.created_at });
  }

  function show() {
    if (done) return;
    done = true;
    var going = new Set();
    latest.forEach(function (v, key) {
      if (v.status === 'accepted') going.add(key.split('|')[0]);
    });
    var n = going.size;
    box.querySelector('[data-rsvp-number]').textContent = String(n);
    box.hidden = false;
  }

  // One relay is enough for a headline; a second one covers the first being down.
  var relays = cfg.RELAYS.slice(0, 2);
  var open = relays.length;
  relays.forEach(function (url) {
    var ws;
    try { ws = new WebSocket(url); } catch (e) { return; }
    var sub = 'count' + Math.random().toString(36).slice(2, 8);
    ws.onopen = function () {
      ws.send(JSON.stringify(['REQ', sub, { kinds: [31925], '#a': coords, limit: 2000 }]));
    };
    ws.onmessage = function (msg) {
      var data;
      try { data = JSON.parse(msg.data); } catch (e) { return; }
      if (data[0] === 'EVENT' && data[2]) note(data[2]);
      else if (data[0] === 'EOSE') {
        open--;
        if (open <= 0) show();
        ws.close();
      }
    };
    ws.onerror = ws.onclose = function () {
      open--;
      if (open <= 0) show();
    };
  });

  setTimeout(show, 6000);
})();
