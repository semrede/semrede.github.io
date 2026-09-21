/* SemRede chat: one NIP-28 public channel (kind 42) on public relays.
 * Rendering follows the geogram station chat (date separators, HH:MM, "Name X1ABCD");
 * the transport is relay subscriptions instead of the station REST API.
 * Relays, profiles, mute list and text helpers live in js/nostr-common.js.
 */
(function () {
  'use strict';

  var NT = window.NostrTools;
  var mod = window.SemRedeMod;
  var net = window.SemRedeNet;
  var auth = window.SemRedeNostr;
  var pool = net.pool;
  var RELAYS = net.RELAYS;
  var CHANNEL_ID = window.SemRedeConfig.CHANNEL_ID;
  var PAGE_SIZE = 100;
  var MAX_LENGTH = 2000;
  var GROUP_WINDOW = 5 * 60;

  var $ = function (id) { return document.getElementById(id); };
  var els = {
    messages: $('messages'), list: $('message-list'), empty: $('chat-empty'), older: $('load-older'),
    composer: $('composer'), input: $('chat-input'), send: $('send-btn'), locked: $('composer-locked'),
    relayDots: $('relay-dots'), relayCount: $('relay-count'), error: null
  };


  var messages = new Map();      // id -> event
  var pending = new Map();       // id -> 'sending' | 'failed'
  var oldestSeen = null;
  var initialLoaded = false;

  function isNearBottom() {
    var c = els.messages;
    return c.scrollHeight - c.scrollTop - c.clientHeight < 120;
  }

  // ---------- rendering ----------

  var renderQueued = false;
  function queueRender(stickToBottom) {
    if (renderQueued) return;
    renderQueued = true;
    var wasNearBottom = isNearBottom();
    requestAnimationFrame(function () {
      renderQueued = false;
      render();
      if (stickToBottom || wasNearBottom) els.messages.scrollTop = els.messages.scrollHeight;
    });
  }

  function render() {
    var list = Array.from(messages.values())
      .filter(function (e) { return !net.isMuted(e.pubkey) && !(mod && mod.isHidden(e.id)); })
      .sort(function (a, b) { return a.created_at - b.created_at || (a.id < b.id ? -1 : 1); });

    var frag = document.createDocumentFragment();
    var lastDay = null, prev = null;
    list.forEach(function (ev) {
      var day = new Date(ev.created_at * 1000).toDateString();
      if (day !== lastDay) {
        var sep = document.createElement('div');
        sep.className = 'day-sep';
        var label = document.createElement('span');
        label.textContent = net.dayLabel(ev.created_at);
        sep.appendChild(label);
        frag.appendChild(sep);
        lastDay = day;
        prev = null;
      }
      var grouped = prev && prev.pubkey === ev.pubkey && ev.created_at - prev.created_at < GROUP_WINDOW;
      frag.appendChild(messageNode(ev, grouped));
      prev = ev;
    });

    els.list.textContent = '';
    els.list.appendChild(frag);
    if (list.length) {
      els.empty.hidden = true;
    } else if (initialLoaded) {
      els.empty.hidden = false;
      els.empty.textContent = 'No messages yet. Say hello and tell people where you are coming from.';
    }
  }

  function messageNode(ev, grouped) {
    var own = auth.pubkey === ev.pubkey;
    var row = document.createElement('article');
    row.className = 'msg' + (own ? ' own' : '') + (grouped ? ' grouped' : '');
    row.style.setProperty('--who', net.colorFor(ev.pubkey));

    var avatar = document.createElement('span');
    avatar.className = 'avatar';
    if (!grouped) net.fillAvatar(avatar, ev.pubkey);
    row.appendChild(avatar);

    var bubble = document.createElement('div');
    bubble.className = 'bubble';
    if (!grouped) {
      var meta = document.createElement('div');
      meta.className = 'meta';
      var name = document.createElement('span');
      name.className = 'name';
      name.textContent = net.displayName(ev.pubkey);
      var cs = document.createElement('span');
      cs.className = 'callsign';
      cs.textContent = auth.deriveCallsign(ev.pubkey);
      cs.title = NT.nip19.npubEncode(ev.pubkey);
      var t = document.createElement('time');
      t.dateTime = new Date(ev.created_at * 1000).toISOString();
      t.textContent = net.timeLabel(ev.created_at);
      meta.append(name, cs, t);
      bubble.appendChild(meta);
    }
    var text = document.createElement('div');
    text.className = 'text';
    net.renderText(text, ev.content);
    bubble.appendChild(text);

    var state = pending.get(ev.id);
    if (state) {
      var s = document.createElement('div');
      s.className = 'send-state ' + state;
      if (state === 'failed') {
        s.textContent = 'Not delivered. ';
        var retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'text-btn';
        retry.textContent = 'Retry';
        retry.onclick = function () { publishSigned(ev); };
        s.appendChild(retry);
      } else {
        s.textContent = 'Sending...';
      }
      bubble.appendChild(s);
    }
    if (mod && mod.isModerator(auth.pubkey) && !own) bubble.appendChild(modTools(ev));

    row.appendChild(bubble);
    return row;
  }

  // Hiding a message takes it off this site; hiding an account does the same
  // for everything that account ever writes here. Neither deletes anything
  // from the relays, and the wording says so.
  function modTools(ev) {
    var box = document.createElement('div');
    box.className = 'msg-mod';

    var hide = document.createElement('button');
    hide.type = 'button';
    hide.className = 'text-btn';
    hide.textContent = 'Hide this message';
    hide.addEventListener('click', function () {
      hide.disabled = true;
      showError('Hiding the message...');
      mod.setHidden(ev.id, true).then(function () {
        showError('Message hidden.', 'ok');
        queueRender(false);
      }, function (err) {
        hide.disabled = false;
        showError((err && err.message) || 'Could not hide the message', 'bad');
      });
    });

    var ban = document.createElement('button');
    ban.type = 'button';
    ban.className = 'text-btn danger';
    ban.textContent = 'Hide this account';
    ban.addEventListener('click', function () {
      var who = net.displayName(ev.pubkey) + ' (' + auth.deriveCallsign(ev.pubkey) + ')';
      if (!window.confirm('Hide everything from ' + who + ' on this site? Their posts stay on the relays and other NOSTR apps still show them.')) return;
      ban.disabled = true;
      showError('Hiding the account...');
      mod.setMuted(ev.pubkey, true).then(function () {
        showError('Account hidden.', 'ok');
        queueRender(false);
      }, function (err) {
        ban.disabled = false;
        showError((err && err.message) || 'Could not hide the account', 'bad');
      });
    });

    box.append(hide, ban);
    return box;
  }

  // ---------- relay traffic ----------

  function isRoomMessage(ev) {
    if (ev.kind !== 42 || typeof ev.content !== 'string' || !ev.content.trim()) return false;
    if (ev.content.length > MAX_LENGTH * 2) return false;
    if (ev.created_at > Date.now() / 1000 + 600) return false;
    return ev.tags.some(function (t) { return t[0] === 'e' && t[1] === CHANNEL_ID; });
  }

  function addMessage(ev) {
    if (messages.has(ev.id) || !isRoomMessage(ev)) return;
    messages.set(ev.id, ev);
    if (oldestSeen === null || ev.created_at < oldestSeen) oldestSeen = ev.created_at;
    net.requestProfile(ev.pubkey);
    queueRender(ev.pubkey === auth.pubkey);
  }

  function subscribeRoom() {
    var timer = setTimeout(markLoaded, 7000);
    function markLoaded() {
      clearTimeout(timer);
      if (initialLoaded) return;
      initialLoaded = true;
      els.older.hidden = messages.size < 20;
      queueRender(true);
    }
    pool.subscribeMany(RELAYS, { kinds: [42], '#e': [CHANNEL_ID], limit: PAGE_SIZE }, {
      onevent: addMessage,
      oneose: markLoaded
    });
    // The admin's mute list and every moderator's, once the team is known.
    net.watchMuteList();
    if (mod) mod.watch();
  }

  function loadOlder() {
    if (oldestSeen === null) return;
    els.older.disabled = true;
    els.older.textContent = 'Loading...';
    var before = els.messages.scrollHeight;
    var until = oldestSeen - 1;
    pool.querySync(RELAYS, { kinds: [42], '#e': [CHANNEL_ID], until: until, limit: PAGE_SIZE }, { maxWait: 6000 })
      .then(function (events) {
        var added = 0;
        events.forEach(function (ev) { if (!messages.has(ev.id) && isRoomMessage(ev)) { added++; } addMessage(ev); });
        requestAnimationFrame(function () {
          render();
          els.messages.scrollTop = els.messages.scrollHeight - before;
        });
        els.older.disabled = false;
        els.older.textContent = 'Load older messages';
        els.older.hidden = added === 0;
      });
  }

  function publishSigned(ev) {
    pending.set(ev.id, 'sending');
    messages.set(ev.id, ev);
    queueRender(true);
    return net.publish(ev).then(function (ok) {
      if (ok) pending.delete(ev.id);
      else pending.set(ev.id, 'failed');
      queueRender(false);
      return ok;
    });
  }

  // ---------- sending ----------

  var sending = false;
  function sendMessage(e) {
    e.preventDefault();
    var content = els.input.value.trim();
    if (!content || sending || !auth.pubkey) return;
    if (content.length > MAX_LENGTH) return;
    sending = true;
    els.send.disabled = true;
    auth.signEvent({
      kind: 42,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['e', CHANNEL_ID, RELAYS[0], 'root']],
      content: content
    }).then(function (ev) {
      if (!NT.verifyEvent(ev)) throw new Error('Signature check failed');
      els.input.value = '';
      autosize();
      return publishSigned(ev);
    }).catch(function (err) {
      showError(err && err.message ? err.message : 'Could not sign the message');
    }).finally(function () {
      sending = false;
      els.send.disabled = false;
      els.input.focus();
    });
  }

  // The login cards live on /login now; here we only open or close the composer.
  function onLoginChange() {
    var loggedIn = !!auth.pubkey;
    els.composer.hidden = !loggedIn;
    els.locked.hidden = loggedIn;
    queueRender(true);
  }

  // The old target for this lived in the login card, which moved to /login, so
  // every message in here was being thrown away. It now has its own line above
  // the composer.
  function statusLine() {
    if (els.error && document.body.contains(els.error)) return els.error;
    var line = document.createElement('p');
    line.className = 'chat-status';
    line.setAttribute('role', 'status');
    var anchor = els.composer || els.messages;
    if (!anchor || !anchor.parentNode) return null;
    anchor.parentNode.insertBefore(line, anchor);
    els.error = line;
    return line;
  }

  function showError(msg, kind) {
    var line = statusLine();
    if (!line) return;
    line.textContent = msg || '';
    line.className = 'chat-status' + (kind ? ' ' + kind : '');
    clearTimeout(line._t);
    if (msg) line._t = setTimeout(function () { line.textContent = ''; }, 6000);
  }

  function autosize() {
    els.input.style.height = 'auto';
    els.input.style.height = Math.min(els.input.scrollHeight, 160) + 'px';
  }

  // Pictures go to a Blossom server and travel as a link in the message.
  function addPictureButton() {
    var blossom = window.SemRedeBlossom;
    if (!blossom || !els.composer) return;
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.hidden = true;
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'pic-btn';
    button.title = 'Add a picture';
    button.setAttribute('aria-label', 'Add a picture');
    button.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">' +
      '<rect x="3" y="5" width="18" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/>' +
      '<circle cx="8.5" cy="10" r="1.6" fill="currentColor"/>' +
      '<path d="M5 17l4.5-5 3.5 4 2.5-2.5L19 17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>';
    button.addEventListener('click', function () { input.click(); });
    input.addEventListener('change', function () {
      var file = input.files && input.files[0];
      input.value = '';
      if (!file || !auth.pubkey) return;
      button.disabled = true;
      showError('Uploading the picture...');
      blossom.upload(file).then(function (result) {
        var text = els.input.value.replace(/\s*$/, '');
        els.input.value = (text ? text + ' ' : '') + result.url;
        autosize();
        els.input.focus();
        showError('');
      }).catch(function (err) {
        showError(err.message || 'Upload failed');
      }).finally(function () { button.disabled = false; });
    });
    els.composer.insertBefore(button, els.send);
    els.composer.appendChild(input);
  }

  function wireUi() {
    els.composer.addEventListener('submit', sendMessage);
    els.input.addEventListener('input', autosize);
    els.input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) sendMessage(e);
    });
    els.older.addEventListener('click', loadOlder);

    document.addEventListener('semrede-login', onLoginChange);
    document.addEventListener('semrede-logout', onLoginChange);
    auth.ready.then(onLoginChange);
    net.onProfile(function () { queueRender(false); });
    net.onMuteChange(function () { queueRender(false); });
    if (mod) mod.onChange(function () { queueRender(false); });
  }

  // ---------- start ----------

  wireUi();
  addPictureButton();
  onLoginChange();
  subscribeRoom();
  net.relayStatus(els.relayDots, els.relayCount);
})();
