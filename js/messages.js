/* /messages: one to one conversations, encrypted with NIP-17 (see js/dm.js).
 * Route: #/<npub or hex> opens that conversation.
 */
(function () {
  'use strict';

  var NT = window.NostrTools;
  var cfg = window.SemRedeConfig;
  var net = window.SemRedeNet;
  var auth = window.SemRedeNostr;
  var dm = window.SemRedeDM;

  var $ = function (id) { return document.getElementById(id); };
  var els = {
    shell: $('dm-shell'), list: $('dm-list'), count: $('dm-count'),
    newForm: $('dm-new'), to: $('dm-to'), newError: $('dm-new-error'),
    pane: $('dm-thread-pane'), peerName: $('dm-peer-name'), peerKey: $('dm-peer-key'),
    messages: $('dm-messages'), empty: $('dm-empty'),
    composer: $('dm-composer'), input: $('dm-input'), send: $('dm-send'),
    locked: $('dm-locked'), lockedText: $('dm-locked-text'),
    relayDots: $('relay-dots')
  };

  var current = null;   // peer pubkey in hex

  function toHex(input) {
    var v = String(input || '').trim();
    if (/^npub1/i.test(v)) {
      var d = NT.nip19.decode(v.toLowerCase());
      if (d.type !== 'npub') throw new Error('That is not an npub');
      return d.data;
    }
    if (/^nprofile1/i.test(v)) {
      var p = NT.nip19.decode(v.toLowerCase());
      if (p.type !== 'nprofile') throw new Error('That is not a profile link');
      return p.data.pubkey;
    }
    if (/^[0-9a-f]{64}$/i.test(v)) return v.toLowerCase();
    if (/^X1[0-9A-Z]{4}$/i.test(v)) {
      // A callsign is only a fingerprint, so it can be matched against people we know.
      var match = null;
      net.profiles.forEach(function (_p, pubkey) {
        if (auth.deriveCallsign(pubkey).toLowerCase() === v.toLowerCase()) match = pubkey;
      });
      dm.conversations().forEach(function (c) {
        if (auth.deriveCallsign(c.peer).toLowerCase() === v.toLowerCase()) match = c.peer;
      });
      if (match) return match;
      throw new Error('That callsign is not someone you have talked to. Paste their npub.');
    }
    throw new Error('Paste an npub, or a callsign like X1ABCD');
  }

  function peerLabel(pubkey) {
    if (pubkey === cfg.ADMIN_PUBKEY) return 'SemRede organizers';
    return net.displayName(pubkey);
  }

  // ---------- list ----------

  function renderList() {
    var list = dm.conversations();
    var organizers = list.filter(function (c) { return c.peer === cfg.ADMIN_PUBKEY; })[0];
    els.list.textContent = '';

    if (!organizers && auth.pubkey) {
      els.list.appendChild(conversationRow({ peer: cfg.ADMIN_PUBKEY, messages: [], unread: 0, last: 0 }, true));
    }
    list.forEach(function (c) { els.list.appendChild(conversationRow(c, false)); });

    var unread = dm.unreadTotal();
    els.count.textContent = !auth.pubkey ? 'private and encrypted'
      : list.length === 0 ? 'no conversations yet'
      : list.length + (list.length === 1 ? ' conversation' : ' conversations') + (unread ? ', ' + unread + ' unread' : '');
  }

  function conversationRow(c, placeholder) {
    var row = document.createElement('a');
    row.className = 'dm-row' + (c.peer === current ? ' active' : '') + (c.unread ? ' unread' : '');
    row.href = '#/' + NT.nip19.npubEncode(c.peer);

    var avatar = document.createElement('span');
    avatar.className = 'avatar';
    net.fillAvatar(avatar, c.peer);

    var main = document.createElement('div');
    main.className = 'dm-row-main';
    var name = document.createElement('strong');
    name.textContent = peerLabel(c.peer);
    var last = document.createElement('span');
    last.className = 'dm-snippet';
    var lastMsg = c.messages[c.messages.length - 1];
    last.textContent = placeholder ? 'Write to the organizers'
      : (lastMsg ? (lastMsg.mine ? 'You: ' : '') + lastMsg.content.replace(/\s+/g, ' ').slice(0, 60) : '');
    main.append(name, last);

    var side = document.createElement('div');
    side.className = 'dm-row-side';
    if (c.last) {
      var time = document.createElement('time');
      time.textContent = net.ago(c.last);
      side.appendChild(time);
    }
    if (c.unread) {
      var badge = document.createElement('span');
      badge.className = 'dm-unread';
      badge.textContent = c.unread;
      side.appendChild(badge);
    }

    row.append(avatar, main, side);
    net.requestProfile(c.peer);
    return row;
  }

  // ---------- thread ----------

  function renderThread() {
    var loggedIn = !!auth.pubkey;
    els.composer.hidden = !loggedIn || !current;
    els.locked.hidden = loggedIn && !!current;
    if (!loggedIn) {
      els.lockedText.textContent = 'Log in to read and write messages.';
    } else if (!auth.canEncrypt()) {
      els.composer.hidden = true;
      els.locked.hidden = false;
      els.lockedText.textContent = 'This browser extension cannot encrypt messages (it has no NIP-44 support). Create an account here, or use Alby or nos2x.';
    } else if (!current) {
      els.lockedText.textContent = 'Pick a conversation, or write to someone with their npub.';
    }

    if (!current) {
      els.peerName.textContent = 'Pick a conversation';
      els.peerKey.textContent = '';
      els.messages.textContent = '';
      els.messages.appendChild(els.empty);
      els.empty.hidden = false;
      return;
    }

    els.peerName.textContent = peerLabel(current);
    els.peerKey.textContent = auth.deriveCallsign(current) + (current === cfg.ADMIN_PUBKEY ? ' / organizers' : '');

    var convo = dm.messagesFor(current);
    els.messages.textContent = '';
    if (!convo.messages.length) {
      var note = document.createElement('p');
      note.className = 'muted-note';
      note.textContent = current === cfg.ADMIN_PUBKEY
        ? 'Write to the organizers. Only they can read it.'
        : 'No messages yet. Say something.';
      els.messages.appendChild(note);
      return;
    }

    var lastDay = null;
    convo.messages.forEach(function (m) {
      var day = new Date(m.created_at * 1000).toDateString();
      if (day !== lastDay) {
        var sep = document.createElement('div');
        sep.className = 'day-sep';
        var label = document.createElement('span');
        label.textContent = net.dayLabel(m.created_at);
        sep.appendChild(label);
        els.messages.appendChild(sep);
        lastDay = day;
      }
      els.messages.appendChild(messageNode(m));
    });
    els.messages.scrollTop = els.messages.scrollHeight;
  }

  function messageNode(m) {
    var row = document.createElement('article');
    row.className = 'msg' + (m.mine ? ' own' : '');
    row.style.setProperty('--who', net.colorFor(m.from));
    var avatar = document.createElement('span');
    avatar.className = 'avatar';
    net.fillAvatar(avatar, m.from);
    var bubble = document.createElement('div');
    bubble.className = 'bubble';
    var meta = document.createElement('div');
    meta.className = 'meta';
    var name = document.createElement('span');
    name.className = 'name';
    name.textContent = m.mine ? 'You' : peerLabel(m.from);
    var time = document.createElement('time');
    time.dateTime = new Date(m.created_at * 1000).toISOString();
    time.textContent = net.timeLabel(m.created_at);
    meta.append(name, time);
    var text = document.createElement('div');
    text.className = 'text';
    net.renderText(text, m.content);
    bubble.append(meta, text);
    row.append(avatar, bubble);
    return row;
  }

  // ---------- routing ----------

  function applyRoute() {
    var h = location.hash.replace(/^#\/?/, '').trim();
    var next = null;
    if (h) {
      try { next = toHex(h); } catch (e) { next = null; }
    }
    current = next;
    els.shell.classList.toggle('thread-open', !!current);
    if (current) dm.markRead(current);
    render();
  }

  var queued = false;
  function render() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(function () {
      queued = false;
      renderList();
      renderThread();
      if (current && auth.pubkey) dm.markRead(current);
    });
  }

  function showError(msg) {
    els.newError.textContent = msg;
    clearTimeout(els.newError._t);
    els.newError._t = setTimeout(function () { els.newError.textContent = ''; }, 6000);
  }

  function autosize() {
    els.input.style.height = 'auto';
    els.input.style.height = Math.min(els.input.scrollHeight, 160) + 'px';
  }

  function sendMessage(e) {
    e.preventDefault();
    var text = els.input.value.trim();
    if (!text || !current) return;
    els.send.disabled = true;
    dm.send(current, text).then(function () {
      els.input.value = '';
      autosize();
      render();
    }).catch(function (err) {
      showError(err.message || 'Could not send the message');
    }).finally(function () {
      els.send.disabled = false;
      els.input.focus();
    });
  }

  function wire() {
    window.addEventListener('hashchange', applyRoute);
    els.newForm.addEventListener('submit', function (e) {
      e.preventDefault();
      try {
        var hex = toHex(els.to.value);
        els.to.value = '';
        location.hash = '#/' + NT.nip19.npubEncode(hex);
      } catch (err) {
        showError(err.message);
      }
    });
    els.composer.addEventListener('submit', sendMessage);
    els.input.addEventListener('input', autosize);
    els.input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) sendMessage(e);
    });
    dm.onChange(render);
    net.onProfile(render);
    document.addEventListener('semrede-login', function () { render(); });
    // The signer may only show up a moment after the page does, and whether it
    // can encrypt decides what this page says.
    document.addEventListener('semrede-signer', function () { render(); });
    document.addEventListener('semrede-logout', function () { current = null; location.hash = ''; render(); });
    auth.ready.then(render);
  }

  wire();
  applyRoute();
  net.watchMuteList();
  net.relayStatus(els.relayDots, null);
})();
