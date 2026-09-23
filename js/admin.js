/* /admin: the moderation desk.
 *
 * Everything here is an ordinary signed NOSTR event, so there is no server to
 * trust: the admin key decides who moderates, and each moderator publishes
 * their own mute list and their own pinned and closed threads.
 */
(function () {
  'use strict';

  var NT = window.NostrTools;
  var cfg = window.SemRedeConfig;
  var net = window.SemRedeNet;
  var auth = window.SemRedeNostr;
  var mod = window.SemRedeMod;
  var core = window.SemRedeTickets;

  var $ = function (id) { return document.getElementById(id); };
  var els = {
    gate: $('admin-gate'), desk: $('admin-desk'), role: $('admin-role'),
    modSection: $('mod-section'), modList: $('mod-list'), modForm: $('mod-form'), modKey: $('mod-key'), modError: $('mod-error'),
    muteList: $('mute-list'), muteForm: $('mute-form'), muteKey: $('mute-key'), muteError: $('mute-error'),
    threadForm: $('thread-form'), threadId: $('thread-id'), threadError: $('thread-error'),
    pinnedList: $('pinned-list'), closedList: $('closed-list'),
    ticketsSummary: $('tickets-summary'), ticketsStatus: $('tickets-status'), ticketsSend: $('tickets-send'),
    waitingList: $('waiting-list'), ticketList: $('ticket-list'),
    relayDots: $('relay-dots')
  };

  function toHex(input) {
    var v = String(input || '').trim();
    if (/^npub1/i.test(v)) {
      var d = NT.nip19.decode(v.toLowerCase());
      if (d.type !== 'npub') throw new Error('That is not an npub');
      return d.data;
    }
    if (/^[0-9a-f]{64}$/i.test(v)) return v.toLowerCase();
    throw new Error('Paste an npub or a 64 character hex key');
  }

  function threadIdFrom(input) {
    var v = String(input || '').trim();
    var hash = /#\/t\/([0-9a-f]{64})/.exec(v);
    if (hash) return hash[1];
    if (/^note1/i.test(v)) {
      var d = NT.nip19.decode(v.toLowerCase());
      if (d.type !== 'note') throw new Error('That is not a note id');
      return d.data;
    }
    if (/^[0-9a-f]{64}$/i.test(v)) return v.toLowerCase();
    throw new Error('Paste a thread link or its id');
  }

  function showError(el, msg) {
    el.textContent = msg;
    clearTimeout(el._t);
    el._t = setTimeout(function () { el.textContent = ''; }, 6000);
  }

  function personRow(pubkey, actionLabel, onAction, extra) {
    var row = document.createElement('div');
    row.className = 'admin-row';
    var avatar = document.createElement('span');
    avatar.className = 'avatar';
    net.fillAvatar(avatar, pubkey);
    net.requestProfile(pubkey);

    var main = document.createElement('div');
    main.className = 'admin-row-main';
    var name = document.createElement('strong');
    name.textContent = net.displayName(pubkey);
    var key = document.createElement('code');
    key.textContent = NT.nip19.npubEncode(pubkey).slice(0, 18) + '...';
    key.title = NT.nip19.npubEncode(pubkey);
    main.append(name, key);
    if (extra) {
      var note = document.createElement('span');
      note.className = 'admin-note';
      note.textContent = extra;
      main.appendChild(note);
    }

    row.append(avatar, main);
    if (onAction) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'text-btn danger';
      button.textContent = actionLabel;
      button.addEventListener('click', function () {
        button.disabled = true;
        onAction().finally(function () { button.disabled = false; render(); });
      });
      row.appendChild(button);
    }
    return row;
  }

  function threadRow(id, label, onAction) {
    var row = document.createElement('div');
    row.className = 'admin-row';
    var main = document.createElement('div');
    main.className = 'admin-row-main';
    var link = document.createElement('a');
    link.href = '/forum#/t/' + id;
    link.textContent = id.slice(0, 16) + '...';
    link.title = id;
    main.appendChild(link);
    row.append(main);
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'text-btn danger';
    button.textContent = label;
    button.addEventListener('click', function () {
      button.disabled = true;
      onAction().finally(function () { button.disabled = false; render(); });
    });
    row.appendChild(button);
    return row;
  }

  function render() {
    var isMod = mod.isModerator(auth.pubkey);
    var isAdmin = mod.isAdmin(auth.pubkey);
    els.gate.hidden = isMod;
    els.desk.hidden = !isMod;
    if (!isMod) return;

    els.role.textContent = isAdmin ? 'You are the admin' : 'You are a moderator';
    els.modSection.hidden = !isAdmin;

    els.modList.textContent = '';
    mod.moderators().forEach(function (pubkey) {
      var admin = mod.isAdmin(pubkey);
      els.modList.appendChild(personRow(
        pubkey,
        'Remove',
        admin ? null : function () {
          return mod.setModerators(mod.moderators().filter(function (pk) { return pk !== pubkey && !mod.isAdmin(pk); }));
        },
        admin ? 'admin, cannot be removed' : null
      ));
    });

    els.muteList.textContent = '';
    var muted = net.mutedList();
    if (!muted.length) {
      var none = document.createElement('p');
      none.className = 'muted-note';
      none.textContent = 'Nobody is hidden right now.';
      els.muteList.appendChild(none);
    }
    muted.forEach(function (pubkey) {
      els.muteList.appendChild(personRow(pubkey, 'Unhide', function () { return mod.setMuted(pubkey, false); }));
    });

    els.pinnedList.textContent = '';
    els.closedList.textContent = '';
    var pinned = mod.pinnedIds();
    var closed = mod.closedIds();
    if (!pinned.length) els.pinnedList.appendChild(emptyNote('No pinned threads.'));
    if (!closed.length) els.closedList.appendChild(emptyNote('No closed threads.'));
    pinned.forEach(function (id) {
      els.pinnedList.appendChild(threadRow(id, 'Unpin', function () { return mod.setPinned(id, false); }));
    });
    closed.forEach(function (id) {
      els.closedList.appendChild(threadRow(id, 'Reopen', function () { return mod.setClosed(id, false); }));
    });

    renderTickets();
  }

  // ---------- tickets ----------

  // The admin and every moderator can send, approve and revoke; each of them
  // signs their own list and their own messages (js/tickets-core.js).
  function renderTickets() {
    var s = core.state();
    var issuer = core.isIssuer();
    els.ticketsSummary.textContent = s.loaded
      ? s.active + ' of ' + s.cap + ' issued, ' + s.queuedSeats + ' to send, ' + s.waitingSeats + ' waiting'
      : 'Counting...';

    var toSend = s.queuedSeats + core.myPending();
    els.ticketsSend.hidden = !issuer || !s.loaded || !toSend;
    els.ticketsSend.textContent = 'Send ' + toSend + (toSend === 1 ? ' ticket' : ' tickets');

    els.waitingList.textContent = '';
    if (!s.waiting.length) els.waitingList.appendChild(emptyNote('Nobody is waiting.'));
    s.waiting.forEach(function (r, i) {
      els.waitingList.appendChild(personRow(r.pubkey, 'Approve',
        issuer ? function () { return ticketAction(core.approve(r.pubkey), 'Tickets sent.'); } : null,
        (i + 1) + ' in line, ' + r.need + (r.need === 1 ? ' ticket' : ' tickets') + ', asked ' + net.ago(core.askedAt(r.pubkey))));
    });

    // Somebody holding more than they now ask for (a smaller group, or not
    // coming any more): the extra numbers are revoked by hand, below.
    var over = new Map();
    s.over.forEach(function (o) { over.set(o.pubkey, o); });

    els.ticketList.textContent = '';
    if (!s.tickets.length) els.ticketList.appendChild(emptyNote('No tickets yet.'));
    s.tickets.slice().reverse().forEach(function (t) {
      var note = core.label(t.n) + ', ' + t.status;
      if (t.by) note += ' by ' + net.displayName(t.by);
      if (s.clashes.has(t.n)) note += ', number given twice';
      var o = t.status !== 'revoked' && over.get(t.pubkey);
      if (o) note += ', holds ' + o.have + ' and asks for ' + o.want;
      els.ticketList.appendChild(personRow(t.pubkey, 'Revoke',
        issuer && t.status !== 'revoked' ? function () {
          if (!confirm('Revoke ticket ' + core.label(t.n) + '? The number is not given to anyone else.')) return Promise.resolve();
          return ticketAction(core.revoke(t.n, t.pubkey), 'Revoked.');
        } : null, note));
    });
  }

  function ticketAction(promise, done) {
    els.ticketsStatus.textContent = 'Working...';
    return promise.then(function () { els.ticketsStatus.textContent = done; },
      function (err) { els.ticketsStatus.textContent = err.message || 'Something failed'; });
  }

  // The automatic part, for the admin key only: with several of the team
  // sending by themselves, two open tabs could number the same person at the
  // same moment. It waits a few seconds after the page opens, so the RSVPs,
  // the ticket lists and the mute list have all arrived first.
  var autoReady = false;
  var autoTimer = null;
  function autoIssue() {
    if (!autoReady || !mod.isAdmin(auth.pubkey)) return;
    clearTimeout(autoTimer);
    autoTimer = setTimeout(function () {
      var s = core.state();
      if (!s.queued.length && !core.myPending()) return;
      ticketAction(core.issueQueued(), 'Tickets sent.');
    }, 1500);
  }

  function emptyNote(text) {
    var p = document.createElement('p');
    p.className = 'muted-note';
    p.textContent = text;
    return p;
  }

  function wire() {
    els.modForm.addEventListener('submit', function (e) {
      e.preventDefault();
      try {
        var hex = toHex(els.modKey.value);
        if (mod.moderators().indexOf(hex) !== -1) throw new Error('Already a moderator');
        els.modKey.value = '';
        mod.setModerators(mod.moderators().concat([hex])).then(render, function () {
          showError(els.modError, 'Could not save the moderator list');
        });
      } catch (err) {
        showError(els.modError, err.message);
      }
    });

    els.muteForm.addEventListener('submit', function (e) {
      e.preventDefault();
      try {
        var hex = toHex(els.muteKey.value);
        els.muteKey.value = '';
        mod.setMuted(hex, true).then(render, function () {
          showError(els.muteError, 'Could not save the mute list');
        });
      } catch (err) {
        showError(els.muteError, err.message);
      }
    });

    els.threadForm.addEventListener('submit', function (e) {
      e.preventDefault();
      try {
        var id = threadIdFrom(els.threadId.value);
        var action = els.threadForm.querySelector('input[name="thread-action"]:checked').value;
        els.threadId.value = '';
        var done = action === 'pin' ? mod.setPinned(id, true) : mod.setClosed(id, true);
        done.then(render, function () { showError(els.threadError, 'Could not save'); });
      } catch (err) {
        showError(els.threadError, err.message);
      }
    });

    document.addEventListener('semrede-login', render);
    document.addEventListener('semrede-logout', render);
    mod.onChange(render);
    net.onProfile(render);
    net.onMuteChange(render);
    auth.ready.then(render);
    core.onChange(function () { render(); autoIssue(); });
    els.ticketsSend.addEventListener('click', function () {
      els.ticketsSend.disabled = true;
      ticketAction(core.issueQueued(), 'Tickets sent.').finally(function () { els.ticketsSend.disabled = false; render(); });
    });
    document.addEventListener('semrede-login', autoIssue);
    setTimeout(function () { autoReady = true; autoIssue(); }, 10000);
  }

  wire();
  mod.watch();
  core.watch();
  render();
  net.relayStatus(els.relayDots, null);
})();
