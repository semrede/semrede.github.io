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

  var $ = function (id) { return document.getElementById(id); };
  var els = {
    gate: $('admin-gate'), desk: $('admin-desk'), role: $('admin-role'),
    modSection: $('mod-section'), modList: $('mod-list'), modForm: $('mod-form'), modKey: $('mod-key'), modError: $('mod-error'),
    muteList: $('mute-list'), muteForm: $('mute-form'), muteKey: $('mute-key'), muteError: $('mute-error'),
    threadForm: $('thread-form'), threadId: $('thread-id'), threadError: $('thread-error'),
    pinnedList: $('pinned-list'), closedList: $('closed-list'),
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
  }

  wire();
  mod.watch();
  render();
  net.relayStatus(els.relayDots, null);
})();
