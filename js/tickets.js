/* /tickets: asking for tickets is a NIP-52 RSVP (kind 31925) to one of the
 * two calendar events of SemRede 2026. There is one button per part, "I'm
 * going", and it cannot be undone here: once pressed it stays, and the group
 * size can only grow. Older "interested" (tentative) and "not this time"
 * (declined) answers are simply not counted. The
 * ['tickets', 'N'] tag says how many people come, the asker included; the
 * others need no name and no account, their tickets are held by this key.
 *
 * The rules (who holds a ticket, who waits) live in js/tickets-core.js, which
 * /admin uses too. Every visitor already has a key (js/nostr-login.js), so the
 * buttons work on the first visit.
 */
(function () {
  'use strict';

  var NT = window.NostrTools;
  var cfg = window.SemRedeConfig;
  var net = window.SemRedeNet;
  var auth = window.SemRedeNostr;
  var core = window.SemRedeTickets;
  var COMMENT_MAX = 500;

  var $ = function (id) { return document.getElementById(id); };
  var els = {
    parts: $('reg-parts'), comment: $('reg-comment'), commentRow: $('reg-comment-row'),
    save: $('reg-save'), status: $('reg-status'), counts: $('reg-counts'), mine: $('my-ticket'),
    nameForm: $('name-form'), nameInput: $('me-name-input'), party: $('reg-party'), relayDots: $('relay-dots')
  };

  var commentTouched = false;
  // The size picked before answering; once going, the answer itself says it.
  var partyChoice = 1;

  function party() {
    return core.wants(auth.pubkey) || partyChoice;
  }

  function myRsvp(slug) {
    var person = auth.pubkey && core.rsvps.get(auth.pubkey);
    return (person && person[slug]) || null;
  }

  function myComment() {
    var person = auth.pubkey && core.rsvps.get(auth.pubkey);
    if (!person) return '';
    var newest = null;
    Object.keys(person).forEach(function (slug) {
      var r = person[slug];
      if (r.comment && (!newest || r.created_at > newest.created_at)) newest = r;
    });
    return newest ? newest.comment : '';
  }

  function eventBySlug(slug) {
    return cfg.EVENTS.filter(function (e) { return e.slug === slug; })[0];
  }

  function tally(slug) {
    var going = 0;
    core.rsvps.forEach(function (person, pubkey) {
      if (net.isMuted(pubkey)) return;
      var r = person[slug];
      if (!r) return;
      if (r.status === 'accepted') going += r.party || 1;
    });
    return { going: going };
  }

  function ownName() {
    var p = auth.pubkey && net.profiles.get(auth.pubkey);
    return (p && p.name) || '';
  }

  // ---------- rendering ----------

  function render() {
    var s = core.state();
    renderCounts(s);
    renderParty();
    renderMine(s);
    renderParts(s);
    if (!commentTouched && document.activeElement !== els.comment) els.comment.value = myComment();
  }

  function renderCounts(s) {
    els.counts.textContent = '';
    var total = document.createElement('div');
    total.className = 'count-box total';
    total.append(bigNumber(s.loaded ? s.left : null), label('of ' + s.cap + ' tickets left'));
    if (s.loaded && s.waitingSeats) {
      var wait = document.createElement('span');
      wait.className = 'count-extra';
      wait.textContent = s.waitingSeats + ' on the waiting list';
      total.appendChild(wait);
    }
    els.counts.appendChild(total);

    cfg.EVENTS.forEach(function (ev) {
      var counts = tally(ev.slug);
      var box = document.createElement('div');
      box.className = 'count-box';
      box.append(bigNumber(s.loaded ? counts.going : null), label(ev.slug === 'eva' ? 'at Eva Farm' : 'at Embaixada'));
      els.counts.appendChild(box);
    });
  }

  // Once going, the size can grow but not shrink: tickets are not given back.
  function renderParty() {
    var current = party();
    var floor = Math.max(core.wants(auth.pubkey), core.standing(auth.pubkey).numbers.length);
    els.party.querySelectorAll('button').forEach(function (b) {
      var n = Number(b.dataset.n);
      b.classList.toggle('chosen', n === current);
      b.disabled = n < floor;
    });
  }

  // The visitor's own tickets, and whatever they still wait for.
  function renderMine(s) {
    var mine = core.standing(auth.pubkey);
    var has = mine.numbers.length > 0;
    els.mine.textContent = '';
    els.mine.className = 'ticket-card ' + (has ? 'ticket' : mine.queue || 'none');
    els.mine.hidden = !s.loaded || (!has && !mine.queue);
    if (els.mine.hidden) return;

    var kicker = document.createElement('span');
    kicker.className = 'ticket-kicker';
    var big = document.createElement('strong');
    big.className = 'ticket-number';
    var plural = mine.need === 1 ? 'your ticket' : 'your ' + mine.need + ' tickets';

    if (has) {
      kicker.textContent = mine.numbers.length === 1 ? 'Your ticket' : 'Your ' + mine.numbers.length + ' tickets';
      els.mine.appendChild(kicker);
      var stubs = document.createElement('div');
      stubs.className = 'ticket-stubs';
      mine.numbers.forEach(function (n, i) { stubs.appendChild(ticketStub(n, i + 1, mine.numbers.length)); });
      els.mine.appendChild(stubs);
    } else {
      if (mine.queue === 'queued') {
        kicker.textContent = mine.need === 1 ? 'Ticket requested' : mine.need + ' tickets requested';
        big.textContent = '...';
      } else {
        kicker.textContent = 'Waiting list';
        big.textContent = String(mine.position);
      }
      els.mine.append(kicker, big);
    }

    var text = document.createElement('p');
    if (has) {
      text.append('Held by ' + (ownName() ? ownName() + ' / ' : '') + auth.callsign +
        '. At the entrance, show this page: the door scans one QR code per person. ',
        link('/messages', 'Your messages'), ' / ', link('/login', 'Back up your key'));
    }
    if (mine.queue === 'queued') {
      if (has) text.append(document.createElement('br'));
      text.append('Your place is kept for ' + (has ? mine.need + ' more' : plural),
        '. The organizers send the numbers to ', link('/messages', 'your messages'), ', usually within a day.');
    } else if (mine.queue === 'waiting') {
      if (has) text.append(document.createElement('br'));
      text.append('All ' + s.cap + ' tickets are taken. You are number ' + mine.position + ' on the waiting list for ' +
        (has ? mine.need + ' more' : plural) + '; if the organizers can let you in, they arrive in ',
        link('/messages', 'your messages'), '.');
    }
    els.mine.appendChild(text);
  }

  // One ticket as it is shown at the door: the number, the event, who holds
  // it, and a QR code linking to /check for this number and this account.
  function ticketStub(n, index, total) {
    var stub = document.createElement('article');
    stub.className = 'ticket-stub';

    var main = document.createElement('div');
    main.className = 'stub-main';
    var event = document.createElement('span');
    event.className = 'stub-event';
    event.textContent = 'SemRede 2026';
    var number = document.createElement('strong');
    number.className = 'stub-number';
    number.textContent = core.label(n);
    var when = document.createElement('span');
    when.className = 'stub-meta';
    when.textContent = 'Coimbra, October 26 to 31';
    var holder = document.createElement('span');
    holder.className = 'stub-meta';
    holder.textContent = (ownName() ? ownName() + ' / ' : '') + auth.callsign;
    var seat = document.createElement('span');
    seat.className = 'stub-seat';
    seat.textContent = 'Ticket ' + index + ' of ' + total;
    main.append(event, number, when, holder, seat);

    var qr = document.createElement('a');
    qr.className = 'stub-qr';
    qr.href = core.checkUrl(n, auth.pubkey);
    qr.title = 'Scanned at the door';
    qr.setAttribute('aria-label', 'QR code for ticket ' + core.label(n));
    qr.appendChild(qrSvg(qr.href));

    stub.append(main, qr);
    return stub;
  }

  // Dark modules on white with the standard four-module quiet zone, which is
  // what phone scanners expect whatever the page colours are.
  function qrSvg(text) {
    var q = window.qrcode(0, 'M');
    q.addData(text);
    q.make();
    var count = q.getModuleCount();
    var size = count + 8;
    var d = '';
    for (var r = 0; r < count; r++) {
      for (var c = 0; c < count; c++) {
        if (q.isDark(r, c)) d += 'M' + (c + 4) + ' ' + (r + 4) + 'h1v1h-1z';
      }
    }
    var NS = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + size + ' ' + size);
    svg.setAttribute('shape-rendering', 'crispEdges');
    var bg = document.createElementNS(NS, 'rect');
    bg.setAttribute('width', size);
    bg.setAttribute('height', size);
    bg.setAttribute('fill', '#fff');
    var path = document.createElementNS(NS, 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', '#000');
    svg.append(bg, path);
    return svg;
  }

  function link(href, text) {
    var a = document.createElement('a');
    a.href = href;
    a.textContent = text;
    return a;
  }

  function renderParts(s) {
    els.parts.textContent = '';
    cfg.EVENTS.forEach(function (ev) {
      var counts = tally(ev.slug);
      var card = document.createElement('article');
      card.className = 'reg-part';

      var head = document.createElement('div');
      head.className = 'reg-part-head';
      var name = document.createElement('h3');
      name.textContent = ev.name;
      var dates = document.createElement('span');
      dates.className = 'reg-dates';
      dates.textContent = ev.dates;
      head.append(name, dates);

      var about = document.createElement('p');
      about.textContent = ev.about;

      var numbers = document.createElement('p');
      numbers.className = 'reg-numbers';
      numbers.textContent = s.loaded
        ? counts.going + (counts.going === 1 ? ' person going' : ' people going')
        : 'Counting...';

      var buttons = document.createElement('div');
      buttons.className = 'reg-buttons';
      var current = myRsvp(ev.slug);
      var going = !!(current && current.status === 'accepted');
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'reg-btn' + (going ? ' chosen' : '');
      b.textContent = going ? "You're going" : "I'm going";
      b.disabled = !auth.pubkey || going;
      b.addEventListener('click', function () { choose(ev.slug, 'accepted'); });
      buttons.appendChild(b);

      card.append(head, about, numbers, buttons);
      els.parts.appendChild(card);
    });
  }

  function bigNumber(value) {
    var n = document.createElement('strong');
    n.textContent = value === null ? '...' : String(value);
    return n;
  }

  function label(text) {
    var l = document.createElement('span');
    l.className = 'count-label';
    l.textContent = text;
    return l;
  }

  // ---------- publishing ----------

  function status(msg, kind) {
    els.status.textContent = msg || '';
    els.status.className = 'reg-status' + (kind ? ' ' + kind : '');
  }

  // The name is optional. One typed but not saved yet is saved on the way,
  // through the account widget's own form.
  function saveTypedName() {
    var typed = els.nameInput.value.replace(/\s+/g, ' ').trim();
    if (typed.length >= 2 && typed !== ownName()) els.nameForm.requestSubmit();
  }

  function choose(slug, value) {
    if (!auth.pubkey) return;
    if (value === 'accepted') saveTypedName();
    publishRsvp(slug, value, els.comment.value.trim().slice(0, COMMENT_MAX));
  }

  // A new size is written on every part they are going to, since that is
  // where it lives.
  function chooseParty(n) {
    if (n < core.wants(auth.pubkey)) return;
    partyChoice = n;
    var going = cfg.EVENTS.filter(function (e) {
      var r = myRsvp(e.slug);
      return r && r.status === 'accepted';
    });
    if (!going.length) return render();
    going.forEach(function (e) { publishRsvp(e.slug, 'accepted', myRsvp(e.slug).comment, n); });
  }

  function publishRsvp(slug, value, comment, size) {
    var ev = eventBySlug(slug);
    status('Saving...');
    return auth.signEvent({
      kind: core.RSVP_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['d', 'semrede-2026-' + slug],
        ['a', ev.coord],
        ['e', ev.id],
        ['status', value],
        ['tickets', String(size || party())],
        ['p', cfg.ADMIN_PUBKEY]
      ],
      content: comment || ''
    }).then(function (signed) {
      if (!NT.verifyEvent(signed)) throw new Error('Signature check failed');
      core.addRsvp(signed);
      return net.publish(signed);
    }).then(function (ok) {
      if (!ok) throw new Error('No relay accepted your answer');
      status('Saved. Thank you.', 'ok');
    }).catch(function (err) {
      status(err.message || 'Could not save your answer', 'bad');
    });
  }

  function saveComment() {
    var comment = els.comment.value.trim().slice(0, COMMENT_MAX);
    var answered = cfg.EVENTS.map(function (e) { return e.slug; }).filter(function (slug) {
      var r = myRsvp(slug);
      return r && r.status === 'accepted';
    });
    if (!answered.length) return status('Pick a part of the event first.', 'bad');
    commentTouched = false;
    Promise.all(answered.map(function (slug) { return publishRsvp(slug, myRsvp(slug).status, comment); }))
      .then(function () { status('Saved. Thank you.', 'ok'); });
  }

  function onLoginChange() {
    els.commentRow.hidden = !auth.pubkey;
    render();
  }

  els.comment.addEventListener('input', function () { commentTouched = true; });
  els.save.addEventListener('click', saveComment);
  for (var i = 1; i <= core.PER_PERSON; i++) {
    (function (n) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'reg-btn';
      b.dataset.n = String(n);
      b.textContent = String(n);
      b.addEventListener('click', function () { chooseParty(n); });
      els.party.appendChild(b);
    })(i);
  }
  document.addEventListener('semrede-login', onLoginChange);
  document.addEventListener('semrede-logout', function () { commentTouched = false; els.comment.value = ''; onLoginChange(); });
  net.onProfile(function () { render(); });
  core.onChange(render);
  auth.ready.then(onLoginChange);

  onLoginChange();
  core.watch();
  net.relayStatus(els.relayDots, null);
})();
