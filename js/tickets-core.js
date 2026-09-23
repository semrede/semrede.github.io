/* Tickets: the rules, in one place, for /tickets and /admin.
 *
 * Asking for tickets is the NIP-52 RSVP that /registration used: status
 * "accepted" (I'm going) on either part of the event, plus a ['tickets', 'N']
 * tag for how many people come along, the asker included (1 to
 * TICKETS.PER_PERSON, 1 when missing). Every one of them gets their own number,
 * all held by the asker's key; nobody else's name or key is needed.
 *
 * The admin key and every moderator it names (js/moderation.js) can issue
 * tickets. Each of them keeps their own public list, a kind 30078 event:
 *
 *   ['d', TICKETS.D]
 *   ['cap', '100']
 *   ['ticket', '<number>', <pubkey>, '<issued_at>', 'pending' | 'sent' | 'revoked']
 *
 * and every page merges the lists of the current team, the same way the forum
 * merges pinned and closed threads. A list from somebody who is not on the team
 * (or no longer is) counts for nothing. In the merge, one entry is a number
 * given to one person: it is revoked when any list says so, sent when any list
 * says so. Revoking somebody else's ticket is done by listing that same entry
 * as revoked in your own list. Numbers are never reused: the next one is always
 * the highest in any list plus one.
 *
 * Who gets what, in order of asking, a party always as a whole:
 *   - the tickets somebody asked for and does not hold yet fit in what is
 *     left of CAP: queued. The admin key's browser issues these by itself
 *     while /admin is open; a moderator sends them with one button there.
 *   - they do not fit: waiting list, and so does everyone who asked later, so
 *     a small party never jumps the line. An admin or a moderator approves
 *     them by hand.
 *   - holding more than they now ask for: /admin shows it, and the team
 *     revokes the extra ones.
 *
 * Issuing sends each ticket as a NIP-17 message from the issuer's own key,
 * through js/dm.js. Your list is published with the ticket as "pending" before
 * the message goes out and as "sent" after, so a closed tab never hands one
 * person two numbers: a pending ticket is simply sent again on the next pass.
 */
(function () {
  'use strict';

  var NT = window.NostrTools;
  var cfg = window.SemRedeConfig;
  var net = window.SemRedeNet;
  var auth = window.SemRedeNostr;
  var mod = window.SemRedeMod;
  var RSVP_KIND = 31925;
  var LEDGER_KIND = 30078;
  var CAP = cfg.TICKETS.CAP;
  var PER_PERSON = cfg.TICKETS.PER_PERSON;
  var D = cfg.TICKETS.D;

  // pubkey -> { slug -> { status, comment, created_at } }
  var rsvps = new Map();
  // issuer pubkey -> { at, entries: [{ n, pubkey, at, status }] }
  var ledgers = new Map();
  // Merged view. holder pubkey -> { live: [entry], revoked: [entry] }, where
  // an entry is { n, pubkey, at, status, by }
  var tickets = new Map();
  var allEntries = [];
  var loaded = { rsvps: false, ledger: false };
  var listeners = [];
  var watching = false;
  var scheduled = false;

  function emit() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(function () {
      scheduled = false;
      listeners.forEach(function (fn) { fn(); });
    }, 0);
  }

  function tagValue(ev, name) {
    for (var i = 0; i < ev.tags.length; i++) if (ev.tags[i][0] === name) return ev.tags[i][1];
    return '';
  }

  function slugForCoord(coord) {
    var match = cfg.EVENTS.filter(function (e) { return e.coord === coord; })[0];
    return match ? match.slug : null;
  }

  function addRsvp(ev) {
    var slug = slugForCoord(tagValue(ev, 'a'));
    var status = tagValue(ev, 'status');
    if (!slug || ['accepted', 'tentative', 'declined'].indexOf(status) === -1) return;
    var person = rsvps.get(ev.pubkey) || {};
    var old = person[slug];
    if (old && old.created_at >= ev.created_at) return;
    person[slug] = { status: status, comment: ev.content || '', created_at: ev.created_at, party: partyFrom(ev) };
    rsvps.set(ev.pubkey, person);
    net.requestProfile(ev.pubkey);
    emit();
  }

  function partyFrom(ev) {
    var n = parseInt(tagValue(ev, 'tickets'), 10);
    return n >= 1 ? Math.min(n, PER_PERSON) : 1;
  }

  function isTeam(pubkey) {
    return pubkey === cfg.ADMIN_PUBKEY || (mod && mod.isModerator(pubkey));
  }

  // Kept for anyone who publishes one; only the team's lists are merged, and
  // that is decided again whenever the team changes.
  function applyLedger(ev) {
    if (ev.kind !== LEDGER_KIND || tagValue(ev, 'd') !== D) return;
    var current = ledgers.get(ev.pubkey);
    if (current && current.at >= ev.created_at) return;
    if (!NT.verifyEvent(ev)) return;
    ledgers.set(ev.pubkey, { at: ev.created_at, entries: parseLedger(ev) });
    merge();
  }

  function parseLedger(ev) {
    var list = [];
    ev.tags.forEach(function (t) {
      if (t[0] !== 'ticket' || !/^[0-9a-f]{64}$/.test(t[2] || '')) return;
      var n = parseInt(t[1], 10);
      if (!(n > 0)) return;
      var status = ['pending', 'sent', 'revoked'].indexOf(t[4]) === -1 ? 'sent' : t[4];
      list.push({ n: n, pubkey: t[2], at: Number(t[3]) || 0, status: status });
    });
    return list;
  }

  var RANK = { pending: 0, sent: 1, revoked: 2 };

  function merge() {
    var byKey = new Map();
    ledgers.forEach(function (ledger, issuer) {
      if (!isTeam(issuer)) return;
      ledger.entries.forEach(function (e) {
        var key = e.n + '|' + e.pubkey;
        var m = byKey.get(key);
        if (!m) {
          byKey.set(key, { n: e.n, pubkey: e.pubkey, at: e.at, status: e.status, by: issuer });
          return;
        }
        if (RANK[e.status] > RANK[m.status]) m.status = e.status;
        if (e.at && (!m.at || e.at < m.at)) { m.at = e.at; m.by = issuer; }
      });
    });
    allEntries = Array.from(byKey.values()).sort(function (a, b) { return a.n - b.n; });
    var next = new Map();
    allEntries.forEach(function (e) {
      var held = next.get(e.pubkey) || { live: [], revoked: [] };
      (e.status === 'revoked' ? held.revoked : held.live).push(e);
      next.set(e.pubkey, held);
    });
    tickets = next;
    emit();
  }

  // ---------- the rules ----------

  function isGoing(pubkey) {
    var person = rsvps.get(pubkey);
    if (!person) return false;
    return cfg.EVENTS.some(function (e) { return person[e.slug] && person[e.slug].status === 'accepted'; });
  }

  // How many tickets somebody asks for now: the largest party on any part
  // they are going to, 0 when they are not going.
  function wants(pubkey) {
    var person = rsvps.get(pubkey);
    if (!person) return 0;
    var n = 0;
    cfg.EVENTS.forEach(function (e) {
      var r = person[e.slug];
      if (r && r.status === 'accepted' && r.party > n) n = r.party;
    });
    return n;
  }

  function held(pubkey) {
    var h = tickets.get(pubkey);
    return h ? h.live : [];
  }

  // When somebody last asked, as far as the relays know: RSVPs are replaced
  // when changed, so asking for more people also moves to the back.
  function askedAt(pubkey) {
    var person = rsvps.get(pubkey) || {};
    var at = Infinity;
    cfg.EVENTS.forEach(function (e) {
      var r = person[e.slug];
      if (r && r.status === 'accepted' && r.created_at < at) at = r.created_at;
    });
    return at;
  }

  function state() {
    var active = 0;
    tickets.forEach(function (h) { active += h.live.length; });

    var asking = [];
    var over = [];
    rsvps.forEach(function (person, pubkey) {
      if (net.isMuted(pubkey)) return;
      var want = wants(pubkey), have = held(pubkey).length;
      if (want > have) asking.push({ pubkey: pubkey, need: want - have, want: want, have: have });
    });
    tickets.forEach(function (h, pubkey) {
      var want = wants(pubkey);
      if (h.live.length > want) over.push({ pubkey: pubkey, want: want, have: h.live.length });
    });
    asking.sort(function (a, b) { return askedAt(a.pubkey) - askedAt(b.pubkey) || (a.pubkey < b.pubkey ? -1 : 1); });

    // First come, first served, a party as a whole. Once one does not fit,
    // everyone after it waits too.
    var free = Math.max(0, CAP - active);
    var queued = [], waiting = [];
    asking.forEach(function (r) {
      if (!waiting.length && r.need <= free) {
        queued.push(r);
        free -= r.need;
      } else {
        waiting.push(r);
      }
    });
    function seats(list) { return list.reduce(function (n, r) { return n + r.need; }, 0); }

    return {
      cap: CAP,
      loaded: loaded.rsvps && loaded.ledger,
      tickets: allEntries.slice(),
      // Two people with one number: only possible when two of the team issue
      // at the same second. /admin shows it so it can be sorted out by hand.
      clashes: clashes(),
      active: active,
      queued: queued,
      queuedSeats: seats(queued),
      waiting: waiting,
      waitingSeats: seats(waiting),
      over: over,
      left: free
    };
  }

  function clashes() {
    var seen = new Map(), out = new Set();
    allEntries.forEach(function (e) {
      if (e.status === 'revoked') return;
      if (seen.has(e.n) && seen.get(e.n) !== e.pubkey) out.add(e.n);
      seen.set(e.n, e.pubkey);
    });
    return out;
  }

  // What this one person holds and still waits for:
  //   { numbers: [n...], want, need, queue: 'queued'|'waiting'|null, position, revoked }
  function standing(pubkey) {
    var out = { numbers: [], want: 0, need: 0, queue: null, position: 0, revoked: false };
    if (!pubkey) return out;
    var h = tickets.get(pubkey);
    out.numbers = held(pubkey).map(function (e) { return e.n; }).sort(function (a, b) { return a - b; });
    out.revoked = !!(h && h.revoked.length);
    out.want = wants(pubkey);
    out.need = Math.max(0, out.want - out.numbers.length);
    if (!out.need) return out;
    var s = state();
    var q = s.queued.filter(function (r) { return r.pubkey === pubkey; })[0];
    if (q) { out.queue = 'queued'; return out; }
    for (var i = 0; i < s.waiting.length; i++) {
      if (s.waiting[i].pubkey === pubkey) { out.queue = 'waiting'; out.position = i + 1; break; }
    }
    return out;
  }

  function label(n) {
    return '#' + String(n).padStart(3, '0');
  }

  // "#004", "#004 and #005", "#004, #005 and #006"
  function labels(numbers) {
    var l = numbers.map(label);
    return l.length < 2 ? l.join('') : l.slice(0, -1).join(', ') + ' and ' + l[l.length - 1];
  }

  // ---------- relay traffic ----------

  function watch() {
    if (watching) return;
    watching = true;
    var coords = cfg.EVENTS.map(function (e) { return e.coord; });
    net.pool.subscribeMany(net.RELAYS, { kinds: [RSVP_KIND], '#a': coords, limit: 2000 }, {
      onevent: addRsvp,
      oneose: function () { loaded.rsvps = true; emit(); }
    });
    // By d tag, not by author: the team can change while the page is open.
    net.pool.subscribeMany(net.RELAYS, { kinds: [LEDGER_KIND], '#d': [D] }, {
      onevent: applyLedger,
      oneose: function () { loaded.ledger = true; emit(); }
    });
    setTimeout(function () { loaded.rsvps = loaded.ledger = true; emit(); }, 8000);
    net.watchMuteList();
    net.onMuteChange(emit);
    if (mod) {
      mod.watch();
      mod.onChange(merge);
    }
  }

  // ---------- issuing: the admin key and the moderators ----------

  function isIssuer() {
    return !!auth.pubkey && isTeam(auth.pubkey);
  }

  // Ask every relay for the newest lists right before writing, so two people
  // issuing at once, or a relay that was slow at load, cannot make us number
  // from a stale copy.
  function refreshLedgers() {
    return net.pool.querySync(net.RELAYS, { kinds: [LEDGER_KIND], '#d': [D] })
      .then(function (events) { events.forEach(applyLedger); });
  }

  function myEntries() {
    var mine = ledgers.get(auth.pubkey);
    return mine ? mine.entries.slice() : [];
  }

  // Publishes this issuer's own list. `change(entries)` returns the new list.
  function publishMine(change) {
    var entries = change(myEntries());
    var tags = [['d', D], ['cap', String(CAP)]];
    entries.sort(function (a, b) { return a.n - b.n; }).forEach(function (t) {
      tags.push(['ticket', String(t.n), t.pubkey, String(t.at), t.status]);
    });
    var mine = ledgers.get(auth.pubkey);
    var createdAt = Math.max(Math.floor(Date.now() / 1000), mine ? mine.at + 1 : 0);
    return auth.signEvent({ kind: LEDGER_KIND, created_at: createdAt, tags: tags, content: '' })
      .then(function (ev) {
        return net.publish(ev).then(function (ok) {
          if (!ok) throw new Error('No relay accepted the ticket list');
          applyLedger(ev);
          return ev;
        });
      });
  }

  function nextNumber() {
    var max = 0;
    ledgers.forEach(function (ledger, issuer) {
      if (!isTeam(issuer)) return;
      ledger.entries.forEach(function (e) { if (e.n > max) max = e.n; });
    });
    return max + 1;
  }

  function message(pubkey, numbers) {
    var npub = NT.nip19.npubEncode(pubkey);
    var one = numbers.length === 1;
    var pt = numbers.map(label);
    pt = pt.length < 2 ? pt.join('') : pt.slice(0, -1).join(', ') + ' e ' + pt[pt.length - 1];
    return [
      'SemRede 2026, ' + (one ? 'ticket ' : 'tickets ') + labels(numbers),
      '',
      (one ? 'This is your entry ticket' : 'These are ' + numbers.length + ' entry tickets, one per person in your group,') +
        ' for SemRede 2026 in Coimbra, October 26 to 31.',
      'They are tied to your NOSTR account on semrede.com, ' + npub + ', and to nothing else: no name, no email.',
      'Show this message, or https://semrede.com/tickets opened with this account, at the entrance. Whoever comes on these tickets comes with you, or you show them for them.',
      'The account lives in this browser. To have it on your phone or another computer too, open https://semrede.com/login, copy your key (Show, then Copy) and paste it at /login on the other device. Keep a copy somewhere safe: a lost key is a lost ticket.',
      '',
      '---',
      '',
      'SemRede 2026, ' + (one ? 'bilhete ' : 'bilhetes ') + pt,
      '',
      (one ? 'Este é o teu bilhete de entrada' : 'Estes são ' + numbers.length + ' bilhetes de entrada, um por cada pessoa do teu grupo,') +
        ' para o SemRede 2026 em Coimbra, de 26 a 31 de outubro.',
      'Estão ligados à tua conta NOSTR em semrede.com, ' + npub + ', e a mais nada: sem nome, sem email.',
      'Mostra esta mensagem, ou https://semrede.com/tickets aberto com esta conta, à entrada. Quem vem com estes bilhetes vem contigo, ou mostras tu os bilhetes por eles.',
      'A conta vive neste browser. Para a teres também no telemóvel ou noutro computador, abre https://semrede.com/login, copia a tua chave (Mostrar, depois Copiar) e cola-a em /login no outro aparelho. Guarda uma cópia num sítio seguro: chave perdida é bilhete perdido.'
    ].join('\n');
  }

  var busy = null;

  // Give numbers to `requests` ([{ pubkey, need }]), then deliver this
  // issuer's pending tickets. `need` is checked again against the fresh lists,
  // so a request somebody else just served is not served twice.
  function issue(requests) {
    if (!isIssuer()) return Promise.reject(new Error('Only the admin and the moderators issue tickets'));
    if (busy) return busy.then(function () { return issue(requests); });
    busy = refreshLedgers().then(function () {
      var now = Math.floor(Date.now() / 1000);
      var fresh = [];
      (requests || []).forEach(function (r) {
        var need = Math.min(r.need, wants(r.pubkey) - held(r.pubkey).length);
        for (var i = 0; i < need; i++) fresh.push(r.pubkey);
      });
      if (!fresh.length) return null;
      var n = nextNumber();
      return publishMine(function (entries) {
        fresh.forEach(function (pubkey) {
          entries.push({ n: n++, pubkey: pubkey, at: now, status: 'pending' });
        });
        return entries;
      });
    }).then(deliverPending).finally(function () { busy = null; });
    return busy;
  }

  // Only what this issuer numbered and nobody has marked sent or revoked.
  function myPending() {
    return myEntries().filter(function (e) {
      if (e.status !== 'pending') return false;
      var merged = allEntries.filter(function (m) { return m.n === e.n && m.pubkey === e.pubkey; })[0];
      return !merged || merged.status === 'pending';
    });
  }

  // One message per person, carrying every number they are due.
  function deliverPending() {
    var byPerson = new Map();
    myPending().forEach(function (e) {
      byPerson.set(e.pubkey, (byPerson.get(e.pubkey) || []).concat([e.n]));
    });
    if (!byPerson.size) return Promise.resolve(0);
    var delivered = [];
    return Array.from(byPerson.keys()).reduce(function (chain, pubkey) {
      return chain.then(function () {
        var numbers = byPerson.get(pubkey).sort(function (a, b) { return a - b; });
        return window.SemRedeDM.send(pubkey, message(pubkey, numbers)).then(function () {
          numbers.forEach(function (n) { delivered.push(n + '|' + pubkey); });
        }, function () { /* retried next pass */ });
      });
    }, Promise.resolve()).then(function () {
      if (!delivered.length) return 0;
      return publishMine(function (entries) {
        return entries.map(function (e) {
          return e.status === 'pending' && delivered.indexOf(e.n + '|' + e.pubkey) !== -1
            ? Object.assign({}, e, { status: 'sent' }) : e;
        });
      }).then(function () { return delivered.length; });
    });
  }

  // The free places, in order of asking. Beyond CAP nothing happens without
  // approve().
  function issueQueued() {
    var s = state();
    if (!s.loaded || !isIssuer()) return Promise.resolve();
    if (!s.queued.length && !myPending().length) return Promise.resolve();
    return issue(s.queued);
  }

  // Everything this person still waits for, beyond the limit if need be.
  function approve(pubkey) {
    return issue([{ pubkey: pubkey, need: PER_PERSON }]);
  }

  // One number, not the person: a party can shrink one ticket at a time.
  function revoke(n, pubkey) {
    if (!isIssuer()) return Promise.reject(new Error('Only the admin and the moderators revoke tickets'));
    return refreshLedgers().then(function () {
      var t = held(pubkey).filter(function (e) { return e.n === n; })[0];
      if (!t) return null;
      return publishMine(function (entries) {
        entries = entries.filter(function (e) { return !(e.n === n && e.pubkey === pubkey); });
        entries.push({ n: n, pubkey: pubkey, at: t.at, status: 'revoked' });
        return entries;
      });
    });
  }

  window.SemRedeTickets = {
    RSVP_KIND: RSVP_KIND,
    rsvps: rsvps,
    addRsvp: addRsvp,
    PER_PERSON: PER_PERSON,
    isGoing: isGoing,
    wants: wants,
    askedAt: askedAt,
    state: state,
    standing: standing,
    label: label,
    labels: labels,
    watch: watch,
    onChange: function (fn) { listeners.push(fn); },
    isIssuer: isIssuer,
    myPending: function () { return myPending().length; },
    issueQueued: issueQueued,
    approve: approve,
    revoke: revoke
  };
})();
