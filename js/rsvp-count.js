/* Registration counter for pages that do not load the NOSTR library.
 * It opens a few relay sockets, asks for the RSVPs (kind 31925) of the two
 * calendar events and counts them. Signatures are not checked here: this is a
 * headline number, and the real list is on /registration.
 *
 * The number is painted every time an answer arrives rather than once at the
 * end: relays disagree about what they hold, and the first one to finish is
 * often the one with nothing.
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
  var painted = false;

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
    var going = new Set();
    latest.forEach(function (v, key) {
      if (v.status === 'accepted') going.add(key.split('|')[0]);
    });
    box.querySelector('[data-rsvp-number]').textContent = String(going.size);
    box.hidden = false;
    painted = true;
  }

  // Several relays, because they do not hold the same events: asking two of
  // them once meant a quiet relay could answer "nothing" and be believed.
  var relays = cfg.RELAYS.slice(0, 4);
  var waiting = relays.length;

  relays.forEach(function (url) {
    var ws;
    try { ws = new WebSocket(url); } catch (e) { waiting--; return; }
    var sub = 'count' + Math.random().toString(36).slice(2, 8);
    var finished = false;

    function finish() {
      if (finished) return;      // EOSE then close used to count twice, which
      finished = true;           // ended the count before the slow relays answered
      waiting--;
      if (waiting <= 0) show();
    }

    ws.onopen = function () {
      ws.send(JSON.stringify(['REQ', sub, { kinds: [31925], '#a': coords, limit: 2000 }]));
    };
    ws.onmessage = function (msg) {
      var data;
      try { data = JSON.parse(msg.data); } catch (e) { return; }
      if (data[0] === 'EVENT' && data[2]) {
        note(data[2]);
        show();                  // every answer moves the number
      } else if (data[0] === 'EOSE') {
        finish();
        try { ws.close(); } catch (e) {}
      }
    };
    ws.onerror = finish;
    ws.onclose = finish;
  });

  // Whatever has arrived after six seconds is what gets shown.
  setTimeout(function () { if (!painted) show(); }, 6000);
})();
