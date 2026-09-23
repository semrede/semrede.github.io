/* Tickets counter for pages that do not load the NOSTR library.
 * It opens a few relay sockets, asks for the RSVPs (kind 31925) of the two
 * calendar events, the moderation team (kind 30000) and the team's ticket lists
 * (kind 30078, merged as in js/tickets-core.js), and shows how many
 * of the tickets are still free: every ticket issued, plus everyone going who
 * is still waiting for theirs, is taken. Signatures are not checked here: this
 * is a headline number, and the real one is on /tickets (js/tickets-core.js).
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
  var ledgers = new Map();  // issuer -> newest ticket list
  var team = null;          // newest moderator list by the admin key
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
    var party = parseInt(tagValue(ev, 'tickets'), 10);
    party = party >= 1 ? Math.min(party, cfg.TICKETS.PER_PERSON) : 1;
    latest.set(key, { status: status, created_at: ev.created_at, party: party });
  }

  function noteLedger(ev) {
    if (tagValue(ev, 'd') === 'semrede-moderators') {
      if (ev.pubkey === cfg.ADMIN_PUBKEY && (!team || ev.created_at > team.created_at)) team = ev;
      return;
    }
    if (tagValue(ev, 'd') !== cfg.TICKETS.D) return;
    var old = ledgers.get(ev.pubkey);
    if (!old || ev.created_at > old.created_at) ledgers.set(ev.pubkey, ev);
  }

  // Live tickets per holder: numbers no list of the team has revoked.
  function ticketsHeld() {
    var members = new Set([cfg.ADMIN_PUBKEY]);
    if (team) team.tags.forEach(function (t) { if (t[0] === 'p') members.add(t[1]); });
    var live = new Map(), revoked = new Set();
    ledgers.forEach(function (ev, issuer) {
      if (!members.has(issuer)) return;
      ev.tags.forEach(function (t) {
        if (t[0] !== 'ticket') return;
        var key = t[1] + '|' + t[2];
        if (t[4] === 'revoked') revoked.add(key);
        else live.set(key, t[2]);
      });
    });
    var held = new Map();
    live.forEach(function (pk, key) { if (!revoked.has(key)) held.set(pk, (held.get(pk) || 0) + 1); });
    return held;
  }

  // Taken: every live ticket, plus what people going still wait for.
  function show() {
    var wants = new Map();
    latest.forEach(function (v, key) {
      if (v.status !== 'accepted') return;
      var pk = key.split('|')[0];
      wants.set(pk, Math.max(wants.get(pk) || 0, v.party));
    });
    var held = ticketsHeld();
    var taken = 0;
    held.forEach(function (n) { taken += n; });
    wants.forEach(function (want, pk) { taken += Math.max(0, want - (held.get(pk) || 0)); });
    box.querySelector('[data-rsvp-number]').textContent = String(Math.max(0, cfg.TICKETS.CAP - taken));
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
      ws.send(JSON.stringify(['REQ', sub, { kinds: [31925], '#a': coords, limit: 2000 },
        { kinds: [30078], '#d': [cfg.TICKETS.D] },
        { kinds: [30000], authors: [cfg.ADMIN_PUBKEY], '#d': ['semrede-moderators'] }]));
    };
    ws.onmessage = function (msg) {
      var data;
      try { data = JSON.parse(msg.data); } catch (e) { return; }
      if (data[0] === 'EVENT' && data[2]) {
        if (data[2].kind === 30078 || data[2].kind === 30000) noteLedger(data[2]);
        else note(data[2]);
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
