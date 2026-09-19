/* SemRede chat: one NIP-28 public channel on public NOSTR relays.
 * Rendering follows the geogram station chat (date separators, HH:MM, "Name X1ABCD");
 * the transport is relay subscriptions instead of the station REST API.
 */
(function () {
  'use strict';

  // ---- Configuration (room created with tools/nostr-admin.mjs create) ----
  var CHANNEL_ID = 'e80c52b1d568d735530c5461d2386d2a28fcaa619f183101af66c973697ad7eb';
  var ADMIN_PUBKEY = 'a98d7aeb75d99c10a945cd1fe308446434344c0ef9b3589d74f87acd1550f4c3';
  var RELAYS = ['wss://relay.primal.net', 'wss://relay.damus.io', 'wss://relay.snort.social', 'wss://nostr-pub.wellorder.net', 'wss://purplerelay.com', 'wss://relay.piazza.today'];
  var PAGE_SIZE = 100;
  var MAX_LENGTH = 2000;
  var GROUP_WINDOW = 5 * 60;

  var NT = window.NostrTools;
  var auth = window.SemRedeNostr;
  var pool = new NT.SimplePool({ enablePing: true, enableReconnect: true });

  var $ = function (id) { return document.getElementById(id); };
  var els = {
    messages: $('messages'), list: $('message-list'), empty: $('chat-empty'), older: $('load-older'),
    composer: $('composer'), input: $('chat-input'), send: $('send-btn'), locked: $('composer-locked'),
    relayDots: $('relay-dots'), relayCount: $('relay-count'),
    loginCard: $('login-card'), meCard: $('me-card'), loginError: $('login-error'), meError: $('me-error'),
    btnExtension: $('btn-extension'), extensionHint: $('extension-hint'),
    createForm: $('create-form'), newName: $('new-name'), importForm: $('import-form'), importKey: $('import-key'),
    meAvatar: $('me-avatar'), meName: $('me-name'), meCallsign: $('me-callsign'),
    nameForm: $('name-form'), nameInput: $('me-name-input'),
    backup: $('backup-box'), nsecValue: $('nsec-value'), nsecReveal: $('nsec-reveal'), nsecCopy: $('nsec-copy'),
    npubValue: $('npub-value'), npubCopy: $('npub-copy'), logout: $('btn-logout')
  };

  var messages = new Map();      // id -> event
  var pending = new Map();       // id -> 'sending' | 'failed'
  var profiles = new Map();      // pubkey -> {name, picture, created_at}
  var profileRequested = new Set();
  var muted = new Set();
  var muteListAt = 0;
  var oldestSeen = null;
  var ownProfileChecked = false;
  var initialLoaded = false;

  // ---------- helpers ----------

  function shortKey(s) { return s.slice(0, 10) + '...' + s.slice(-6); }

  function displayName(pubkey) {
    var p = profiles.get(pubkey);
    return (p && p.name) || auth.deriveCallsign(pubkey);
  }

  function colorFor(pubkey) {
    var palette = ['var(--orange)', 'var(--yellow)', 'var(--teal)', 'var(--green)'];
    return palette[parseInt(pubkey.slice(-2), 16) % palette.length];
  }

  function fillAvatar(el, pubkey) {
    el.textContent = '';
    el.style.setProperty('--avatar', colorFor(pubkey));
    var p = profiles.get(pubkey);
    if (p && p.picture) {
      var img = document.createElement('img');
      img.src = p.picture;
      img.alt = '';
      img.loading = 'lazy';
      img.referrerPolicy = 'no-referrer';
      img.onerror = function () { img.remove(); el.textContent = initials(pubkey); };
      el.appendChild(img);
    } else {
      el.textContent = initials(pubkey);
    }
  }

  function initials(pubkey) {
    var name = displayName(pubkey).replace(/^X1/, '');
    return name.trim().slice(0, 2).toUpperCase();
  }

  function dayLabel(ts) {
    var d = new Date(ts * 1000);
    var today = new Date();
    var yesterday = new Date(Date.now() - 864e5);
    if (d.toDateString() === today.toDateString()) return 'Today';
    if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
    return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
  }

  function timeLabel(ts) {
    return new Date(ts * 1000).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  }

  // Text with clickable links, built from nodes only (no HTML from other users).
  function renderText(container, text) {
    var re = /https?:\/\/[^\s<>"']+/g;
    var last = 0, m;
    while ((m = re.exec(text))) {
      var url = m[0].replace(/[.,!?;:)\]]+$/, '');
      if (m.index > last) container.appendChild(document.createTextNode(text.slice(last, m.index)));
      var a = document.createElement('a');
      a.href = url;
      a.textContent = url;
      a.target = '_blank';
      a.rel = 'noopener nofollow ugc';
      container.appendChild(a);
      last = m.index + url.length;
    }
    if (last < text.length) container.appendChild(document.createTextNode(text.slice(last)));
  }

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
      .filter(function (e) { return !muted.has(e.pubkey); })
      .sort(function (a, b) { return a.created_at - b.created_at || (a.id < b.id ? -1 : 1); });

    var frag = document.createDocumentFragment();
    var lastDay = null, prev = null;
    list.forEach(function (ev) {
      var day = new Date(ev.created_at * 1000).toDateString();
      if (day !== lastDay) {
        var sep = document.createElement('div');
        sep.className = 'day-sep';
        sep.innerHTML = '<span></span>';
        sep.firstChild.textContent = dayLabel(ev.created_at);
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
    row.style.setProperty('--who', colorFor(ev.pubkey));

    var avatar = document.createElement('span');
    avatar.className = 'avatar';
    if (!grouped) fillAvatar(avatar, ev.pubkey);
    row.appendChild(avatar);

    var bubble = document.createElement('div');
    bubble.className = 'bubble';
    if (!grouped) {
      var meta = document.createElement('div');
      meta.className = 'meta';
      var name = document.createElement('span');
      name.className = 'name';
      name.textContent = displayName(ev.pubkey);
      var cs = document.createElement('span');
      cs.className = 'callsign';
      cs.textContent = auth.deriveCallsign(ev.pubkey);
      cs.title = NT.nip19.npubEncode(ev.pubkey);
      var t = document.createElement('time');
      t.dateTime = new Date(ev.created_at * 1000).toISOString();
      t.textContent = timeLabel(ev.created_at);
      meta.append(name, cs, t);
      bubble.appendChild(meta);
    }
    var text = document.createElement('div');
    text.className = 'text';
    renderText(text, ev.content);
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
    row.appendChild(bubble);
    return row;
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
    requestProfile(ev.pubkey);
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
    pool.subscribeMany(RELAYS, { kinds: [10000], authors: [ADMIN_PUBKEY] }, {
      onevent: function (ev) {
        if (ev.created_at <= muteListAt) return;
        muteListAt = ev.created_at;
        muted = new Set(ev.tags.filter(function (t) { return t[0] === 'p'; }).map(function (t) { return t[1]; }));
        queueRender(false);
      }
    });
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

  // Batch kind 0 lookups so a busy room does not open one subscription per author.
  var profileBatch = new Set();
  var profileTimer = null;
  function requestProfile(pubkey) {
    if (profileRequested.has(pubkey)) return;
    profileRequested.add(pubkey);
    profileBatch.add(pubkey);
    clearTimeout(profileTimer);
    profileTimer = setTimeout(flushProfiles, 250);
  }

  function flushProfiles() {
    var authors = Array.from(profileBatch);
    profileBatch.clear();
    if (!authors.length) return;
    pool.subscribeManyEose(RELAYS, { kinds: [0], authors: authors }, {
      onevent: function (ev) { applyProfile(ev); }
    });
  }

  function applyProfile(ev) {
    var old = profiles.get(ev.pubkey);
    if (old && old.created_at >= ev.created_at) return;
    var data = {};
    try { data = JSON.parse(ev.content) || {}; } catch (e) { return; }
    var name = String(data.display_name || data.name || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    var picture = typeof data.picture === 'string' && /^https:\/\//.test(data.picture) ? data.picture : '';
    profiles.set(ev.pubkey, { name: name, picture: picture, created_at: ev.created_at, raw: data });
    if (ev.pubkey === auth.pubkey) showIdentity();
    queueRender(false);
  }

  function updateRelayStatus() {
    var status = pool.listConnectionStatus();
    var up = 0;
    els.relayDots.textContent = '';
    RELAYS.forEach(function (url) {
      var ok = status.get(url) || status.get(url + '/');
      if (ok) up++;
      var dot = document.createElement('i');
      dot.className = ok ? 'up' : 'down';
      dot.title = url.replace('wss://', '') + (ok ? ' connected' : ' offline');
      els.relayDots.appendChild(dot);
    });
    els.relayCount.textContent = up + '/' + RELAYS.length + ' relays';
  }

  function publishSigned(ev) {
    pending.set(ev.id, 'sending');
    messages.set(ev.id, ev);
    queueRender(true);
    return Promise.allSettled(pool.publish(RELAYS, ev)).then(function (results) {
      var ok = results.some(function (r) { return r.status === 'fulfilled'; });
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
      showError(els.meError, err && err.message ? err.message : 'Could not sign the message');
    }).finally(function () {
      sending = false;
      els.send.disabled = false;
      els.input.focus();
    });
  }

  function autosize() {
    els.input.style.height = 'auto';
    els.input.style.height = Math.min(els.input.scrollHeight, 160) + 'px';
  }

  // ---------- identity UI ----------

  function showError(el, msg) {
    el.textContent = msg;
    clearTimeout(el._t);
    el._t = setTimeout(function () { el.textContent = ''; }, 6000);
  }

  function showIdentity() {
    var loggedIn = !!auth.pubkey;
    els.loginCard.hidden = loggedIn;
    els.meCard.hidden = !loggedIn;
    els.composer.hidden = !loggedIn;
    els.locked.hidden = loggedIn;
    if (!loggedIn) return;
    var p = profiles.get(auth.pubkey);
    els.meName.textContent = displayName(auth.pubkey);
    els.meCallsign.textContent = auth.callsign + (auth.mode === 'extension' ? ' / extension' : ' / this browser');
    fillAvatar(els.meAvatar, auth.pubkey);
    if (document.activeElement !== els.nameInput) els.nameInput.value = (p && p.name) || '';
    els.npubValue.textContent = shortKey(auth.npub());
    els.backup.hidden = auth.mode !== 'local';
    els.nsecValue.textContent = 'nsec1' + '*'.repeat(12);
    els.nsecValue.dataset.shown = '';
    els.nsecReveal.textContent = 'Show';
  }

  // Publish kind 0, keeping fields an existing profile already has (picture, about, nip05...).
  function saveName(name) {
    if (!ownProfileChecked) return fetchOwnProfile().then(function () { return saveName(name); });
    var p = profiles.get(auth.pubkey);
    var data = Object.assign({}, (p && p.raw) || {});
    data.name = name;
    data.display_name = name;
    return auth.signEvent({ kind: 0, created_at: Math.floor(Date.now() / 1000), tags: [], content: JSON.stringify(data) })
      .then(function (ev) {
        applyProfile(ev);
        return Promise.allSettled(pool.publish(RELAYS, ev));
      });
  }

  function fetchOwnProfile() {
    return pool.get(RELAYS, { kinds: [0], authors: [auth.pubkey] }, { maxWait: 4000 }).then(function (ev) {
      if (ev) applyProfile(ev);
      ownProfileChecked = true;
    });
  }

  function onLogin() {
    ownProfileChecked = false;
    profileRequested.add(auth.pubkey);
    showIdentity();
    queueRender(true);
    fetchOwnProfile();
  }

  function copy(text, btn) {
    navigator.clipboard.writeText(text).then(function () {
      var old = btn.textContent;
      btn.textContent = 'Copied';
      setTimeout(function () { btn.textContent = old; }, 1500);
    });
  }

  function wireUi() {
    els.composer.addEventListener('submit', sendMessage);
    els.input.addEventListener('input', autosize);
    els.input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) sendMessage(e);
    });
    els.older.addEventListener('click', loadOlder);

    els.btnExtension.addEventListener('click', function () {
      auth.loginWithExtension().catch(function (err) {
        showError(els.loginError, err.message === 'No NOSTR extension found'
          ? 'No NOSTR extension found in this browser. Create an account instead, or install Alby or nos2x.'
          : 'The extension did not share a key.');
      });
    });

    els.createForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var name = els.newName.value.replace(/\s+/g, ' ').trim();
      if (name.length < 2) return showError(els.loginError, 'Pick a name with at least 2 characters.');
      auth.createAccount().then(function () {
        profiles.set(auth.pubkey, { name: name, picture: '', created_at: 0, raw: {} });
        ownProfileChecked = true;
        showIdentity();
        return saveName(name);
      });
    });

    els.importForm.addEventListener('submit', function (e) {
      e.preventDefault();
      try {
        auth.importKey(els.importKey.value);
        els.importKey.value = '';
      } catch (err) {
        showError(els.loginError, err.message);
      }
    });

    els.nameForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var name = els.nameInput.value.replace(/\s+/g, ' ').trim();
      if (name.length < 2) return showError(els.meError, 'Use at least 2 characters.');
      saveName(name).then(function () { els.nameInput.blur(); showIdentity(); },
        function () { showError(els.meError, 'Could not save the name.'); });
    });

    els.nsecReveal.addEventListener('click', function () {
      var shown = els.nsecValue.dataset.shown === '1';
      els.nsecValue.textContent = shown ? 'nsec1' + '*'.repeat(12) : auth.nsec();
      els.nsecValue.dataset.shown = shown ? '' : '1';
      els.nsecReveal.textContent = shown ? 'Show' : 'Hide';
    });
    els.nsecCopy.addEventListener('click', function () { copy(auth.nsec(), els.nsecCopy); });
    els.npubCopy.addEventListener('click', function () { copy(auth.npub(), els.npubCopy); });
    els.logout.addEventListener('click', function () {
      if (auth.mode === 'local' && !confirm('This account only exists in this browser. Log out only if you saved your key. Log out?')) return;
      auth.logout();
    });

    document.addEventListener('semrede-login', onLogin);
    document.addEventListener('semrede-logout', function () { showIdentity(); queueRender(false); });
  }

  // ---------- start ----------

  wireUi();
  showIdentity();
  subscribeRoom();
  updateRelayStatus();
  setInterval(updateRelayStatus, 4000);
  auth.ready.then(function () {
    els.extensionHint.classList.toggle('found', auth.extensionAvailable);
    if (!auth.extensionAvailable) els.btnExtension.classList.add('muted');
  });
})();
