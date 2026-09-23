/* /check: what a ticket's QR code opens at the door.
 *
 * The link carries the ticket number and the holder's account
 * (?t=4&p=npub1...). The answer comes from the team's public ticket lists,
 * merged by js/tickets-core.js exactly as /tickets and /admin do, so a number
 * the organizers never gave to that account cannot pass.
 *
 * "Let in" is remembered on this phone only (localStorage), which is enough to
 * catch one ticket shown twice at the same door.
 */
(function () {
  'use strict';

  var NT = window.NostrTools;
  var net = window.SemRedeNet;
  var core = window.SemRedeTickets;
  var ADMITTED = 'semrede_admitted';

  var $ = function (id) { return document.getElementById(id); };
  var els = {
    box: $('check-result'), verdict: $('check-verdict'), number: $('check-number'),
    holder: $('check-holder'), avatar: $('check-avatar'), name: $('check-name'), callsign: $('check-callsign'),
    detail: $('check-detail'), admit: $('check-admit'), relayDots: $('relay-dots')
  };

  function param(name) {
    var m = new RegExp('[?&]' + name + '=([^&#]+)').exec(location.search);
    return m ? decodeURIComponent(m[1]) : '';
  }

  function pubkeyFrom(value) {
    if (/^[0-9a-f]{64}$/i.test(value)) return value.toLowerCase();
    try {
      var d = NT.nip19.decode(value);
      return d.type === 'npub' ? d.data : null;
    } catch (e) { return null; }
  }

  var n = parseInt(param('t'), 10);
  var pubkey = pubkeyFrom(param('p'));
  var patience = false;   // a "not found" is only believed once the lists had time to arrive

  function admitted() {
    try { return JSON.parse(localStorage.getItem(ADMITTED) || '{}') || {}; } catch (e) { return {}; }
  }

  function key() { return n + '|' + pubkey; }

  function show(kind, verdict, detail) {
    els.box.className = 'check-result ' + kind;
    els.verdict.textContent = verdict;
    els.detail.textContent = detail || '';
  }

  function render() {
    if (!(n > 0) || !pubkey) {
      els.holder.hidden = true;
      els.admit.hidden = true;
      return show('bad', 'Not a ticket', 'This link is missing its ticket number or its account.');
    }
    els.number.textContent = core.label(n);
    els.holder.hidden = false;
    net.requestProfile(pubkey);
    net.fillAvatar(els.avatar, pubkey);
    els.name.textContent = net.displayName(pubkey);
    els.callsign.textContent = window.SemRedeSession.deriveCallsign(pubkey);

    var s = core.state();
    var r = core.check(n, pubkey);
    els.admit.hidden = true;

    if (r.status === 'valid') {
      var seen = admitted()[key()];
      if (seen) {
        return show('warn', 'Already let in',
          'This ticket was let in on this phone at ' + new Date(seen).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + '.');
      }
      els.admit.hidden = false;
      var group = r.numbers.length > 1 ? 'Group of ' + r.numbers.length + ': ' + core.labels(r.numbers) + '.' : 'One person.';
      return show('ok', 'Valid', group + (r.clash ? ' Careful: this number was given twice, ask the organizers.' : ''));
    }
    if (!s.loaded || !patience) return show('checking', 'Checking...', 'Reading the ticket lists from the relays.');
    if (r.status === 'revoked') return show('bad', 'Revoked', 'The organizers took this ticket back.');
    if (r.status === 'mismatch') return show('bad', 'Wrong account', 'This number belongs to somebody else.');
    show('bad', 'Not found', 'No ticket with this number was given to this account.');
  }

  els.admit.addEventListener('click', function () {
    var map = admitted();
    map[key()] = Date.now();
    try { localStorage.setItem(ADMITTED, JSON.stringify(map)); } catch (e) { /* private mode */ }
    els.admit.hidden = true;
    show('ok', 'Let in', 'Enjoy SemRede.');
  });

  core.onChange(render);
  net.onProfile(function (pk) { if (pk === pubkey) render(); });
  // The moderators' lists arrive after the moderator set itself, so give a
  // missing ticket a few seconds before calling it one.
  setTimeout(function () { patience = true; render(); }, 5000);

  render();
  core.watch();
  net.relayStatus(els.relayDots, null);
})();
