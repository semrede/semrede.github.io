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

  // ---------- keeping the newest message in sight ----------
  //
  // The room follows the bottom until somebody scrolls up, and goes back to
  // following as soon as they scroll down again. Pictures and avatars arrive
  // after the message they belong to, so the list is watched for growth as
  // well: without that, the view ends up a few hundred pixels short of the
  // newest message every time an image finishes loading.

  var stuck = true;         // is the view following the newest message
  var restoring = false;    // "load older" is putting the old position back

  function pin() {
    var c = els.messages;
    var bottom = c.scrollHeight - c.clientHeight;
    if (Math.abs(c.scrollTop - bottom) > 1) c.scrollTop = bottom;
  }

  els.messages.addEventListener('scroll', function () {
    if (restoring) return;
    stuck = isNearBottom();
  }, { passive: true });

  if (window.ResizeObserver && els.list) {
    new ResizeObserver(function () {
      if (stuck && !restoring) pin();
    }).observe(els.list);
  }

  // ---------- rendering ----------

  var renderQueued = false;
  var renderStick = false;
  function queueRender(stickToBottom) {
    // Renders collapse into one frame, so the request to stick has to survive
    // the collapse; otherwise a message sent while another render is queued
    // scrolls nowhere.
    renderStick = renderStick || stickToBottom || stuck;
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(function () {
      renderQueued = false;
      var goToBottom = renderStick;
      renderStick = false;
      render();
      if (goToBottom) {
        stuck = true;
        pin();
        // once more after layout, for anything that changed size in between
        requestAnimationFrame(pin);
      }
    });
  }

  // What a message looks like right now. If this has not changed, the node on
  // screen is already correct and is left exactly as it is: rebuilding it is
  // what made the room flicker, because every avatar and every picture was
  // thrown away and fetched again on any incoming event.
  function signature(ev, grouped) {
    var profile = net.profiles.get(ev.pubkey);
    var quoted = quotedId(ev);
    return [
      ev.id,
      grouped ? 'g' : '',
      pending.get(ev.id) || '',
      likeCount(ev.id),
      myLike(ev.id) ? 'mine' : '',
      net.displayName(ev.pubkey),
      (profile && profile.picture) || '',
      quoted ? quoted + (messages.has(quoted) ? 'y' : 'n') : '',
      (mod && mod.isModerator(auth.pubkey)) ? 'm' : '',
      auth.pubkey === ev.pubkey ? 'own' : ''
    ].join('|');
  }

  function render() {
    var list = Array.from(messages.values())
      .filter(function (e) { return !net.isMuted(e.pubkey) && !(mod && mod.isHidden(e.id)); })
      .sort(function (a, b) { return a.created_at - b.created_at || (a.id < b.id ? -1 : 1); });

    // What the list should hold, in order, each with a key and a way to tell
    // whether the node already on screen is still right.
    var wanted = [];
    var lastDay = null, prev = null;
    list.forEach(function (ev) {
      var day = new Date(ev.created_at * 1000).toDateString();
      if (day !== lastDay) {
        var label = net.dayLabel(ev.created_at);
        wanted.push({
          key: 'day:' + day,
          sig: label,
          make: function () {
            var sep = document.createElement('div');
            sep.className = 'day-sep';
            var span = document.createElement('span');
            span.textContent = label;
            sep.appendChild(span);
            return sep;
          }
        });
        lastDay = day;
        prev = null;
      }
      var grouped = !!(prev && prev.pubkey === ev.pubkey && ev.created_at - prev.created_at < GROUP_WINDOW);
      wanted.push({
        key: 'msg:' + ev.id,
        sig: signature(ev, grouped),
        make: function () { return messageNode(ev, grouped); }
      });
      prev = ev;
    });

    var existing = new Map();
    Array.prototype.forEach.call(els.list.children, function (node) {
      if (node.dataset.key) existing.set(node.dataset.key, node);
    });

    wanted.forEach(function (item, index) {
      var node = existing.get(item.key);
      if (!node || node.dataset.sig !== item.sig) {
        node = item.make();
        node.dataset.key = item.key;
        node.dataset.sig = item.sig;
      }
      var atPosition = els.list.children[index];
      if (atPosition !== node) els.list.insertBefore(node, atPosition || null);
    });

    while (els.list.children.length > wanted.length) els.list.removeChild(els.list.lastChild);

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
    row.dataset.id = ev.id;
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
    var quoted = quotedId(ev);
    if (quoted) bubble.appendChild(quoteNode(quoted));

    var text = document.createElement('div');
    text.className = 'text';
    net.renderText(text, ev.content);
    bubble.appendChild(text);

    bubble.appendChild(reactions(ev));

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

  function reactions(ev) {
    var row = document.createElement('div');
    row.className = 'msg-actions';

    var count = likeCount(ev.id);
    var like = document.createElement('button');
    like.type = 'button';
    like.className = 'like-btn' + (myLike(ev.id) ? ' liked' : '');
    like.title = auth.pubkey ? 'Like this message' : 'Log in to like';
    like.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">' +
      '<path d="M12 20s-7-4.6-7-9.3A4 4 0 0 1 12 7a4 4 0 0 1 7 3.7C19 15.4 12 20 12 20z" ' +
      'fill="currentColor" fill-opacity="var(--heart-fill, 0)" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>';
    var n = document.createElement('span');
    n.className = 'like-count';
    n.textContent = count ? String(count) : '';
    like.appendChild(n);
    like.addEventListener('click', function () { toggleLike(ev); });
    row.appendChild(like);

    if (auth.pubkey) {
      var quote = document.createElement('button');
      quote.type = 'button';
      quote.className = 'quote-btn';
      quote.textContent = 'Quote';
      quote.addEventListener('click', function () { setReplyTo(ev); });
      row.appendChild(quote);
    }
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

  // ---------- likes (NIP-25) and quoting (NIP-28 replies) ----------

  var likes = new Map();        // message id -> Map(pubkey -> reaction id)
  var deletedLikes = new Set();
  var watchedLikes = new Set();
  var likeTimer = null;
  var replyTo = null;           // the message being answered, if any

  function addReaction(ev) {
    if (ev.kind === 5) {
      ev.tags.forEach(function (t) {
        if (t[0] !== 'e') return;
        deletedLikes.add(t[1]);
        likes.forEach(function (map, id) {
          map.forEach(function (reactionId, pubkey) { if (reactionId === t[1]) map.delete(pubkey); });
        });
      });
      queueRender(false);
      return;
    }
    if (ev.kind !== 7 || deletedLikes.has(ev.id)) return;
    // "+" is the NIP-25 like; a bare heart or thumb means the same thing.
    if (['+', '', '\u2764', '\ud83d\udc4d'].indexOf(ev.content) === -1) return;
    var target = ev.tags.filter(function (t) { return t[0] === 'e'; }).pop();
    if (!target || !messages.has(target[1])) return;
    var map = likes.get(target[1]);
    if (!map) { map = new Map(); likes.set(target[1], map); }
    if (map.get(ev.pubkey) === ev.id) return;
    map.set(ev.pubkey, ev.id);
    net.requestProfile(ev.pubkey);
    queueRender(false);
  }

  function likeCount(id) {
    var map = likes.get(id);
    if (!map) return 0;
    var n = 0;
    map.forEach(function (_, pubkey) { if (!net.isMuted(pubkey)) n++; });
    return n;
  }

  function myLike(id) {
    var map = likes.get(id);
    return (map && auth.pubkey && map.get(auth.pubkey)) || null;
  }

  // Reactions are asked for in batches, as messages arrive.
  function watchLikes() {
    clearTimeout(likeTimer);
    likeTimer = setTimeout(function () {
      var ids = [];
      messages.forEach(function (ev, id) { if (!watchedLikes.has(id)) { watchedLikes.add(id); ids.push(id); } });
      if (!ids.length) return;
      for (var i = 0; i < ids.length; i += 50) {
        pool.subscribeMany(RELAYS, { kinds: [7, 5], '#e': ids.slice(i, i + 50) }, { onevent: addReaction });
      }
    }, 400);
  }

  function toggleLike(ev) {
    if (!auth.pubkey) { showError('Log in to like a message.', 'bad'); return; }
    var existing = myLike(ev.id);
    if (existing) {
      var map = likes.get(ev.id);
      if (map) map.delete(auth.pubkey);
      queueRender(false);
      auth.signEvent({ kind: 5, created_at: Math.floor(Date.now() / 1000), tags: [['e', existing], ['k', '7']], content: 'like removed' })
        .then(function (signed) { deletedLikes.add(existing); return net.publish(signed); })
        .catch(function (err) { showError((err && err.message) || 'Could not take the like back', 'bad'); });
      return;
    }
    auth.signEvent({
      kind: 7,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['e', ev.id, RELAYS[0]], ['p', ev.pubkey], ['k', String(ev.kind)]],
      content: '+'
    }).then(function (signed) {
      addReaction(signed);
      return net.publish(signed).then(function (ok) {
        if (!ok) throw new Error('No relay accepted the like');
      });
    }).catch(function (err) {
      var map = likes.get(ev.id);
      if (map && auth.pubkey) map.delete(auth.pubkey);
      queueRender(false);
      showError((err && err.message) || 'Could not like the message', 'bad');
    });
  }

  function quotedId(ev) {
    var reply = ev.tags.filter(function (t) { return t[0] === 'e' && t[3] === 'reply'; })[0];
    if (reply) return reply[1];
    // Older clients tag the answered message without marking it.
    var others = ev.tags.filter(function (t) { return t[0] === 'e' && t[1] !== CHANNEL_ID; });
    return others.length ? others[others.length - 1][1] : null;
  }

  function setReplyTo(ev) {
    replyTo = ev;
    drawReplyBar();
    if (els.input) els.input.focus();
  }

  function drawReplyBar() {
    var bar = document.getElementById('reply-bar');
    if (!replyTo || !auth.pubkey) {
      if (bar) bar.remove();
      return;
    }
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'reply-bar';
      bar.className = 'reply-bar';
      els.composer.parentNode.insertBefore(bar, els.composer);
    }
    bar.textContent = '';
    var who = document.createElement('strong');
    who.textContent = net.displayName(replyTo.pubkey);
    var text = document.createElement('span');
    text.className = 'reply-bar-text';
    text.textContent = replyTo.content.replace(/\s+/g, ' ').slice(0, 90);
    var cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'text-btn';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', function () { replyTo = null; drawReplyBar(); });
    bar.append(who, text, cancel);
  }

  // The message being answered, drawn above the answer.
  function quoteNode(id) {
    var quoted = messages.get(id);
    var box = document.createElement('div');
    box.className = 'quote';
    if (!quoted) {
      box.classList.add('missing');
      box.textContent = 'A message that is not loaded here';
      return box;
    }
    if (net.isMuted(quoted.pubkey) || (mod && mod.isHidden(quoted.id))) {
      box.classList.add('missing');
      box.textContent = 'A hidden message';
      return box;
    }
    var who = document.createElement('strong');
    who.textContent = net.displayName(quoted.pubkey);
    var text = document.createElement('span');
    text.textContent = quoted.content.replace(/\s+/g, ' ').slice(0, 140);
    box.append(who, text);
    box.addEventListener('click', function () {
      var target = els.messages.querySelector('[data-id="' + id + '"]');
      if (!target) return;
      target.scrollIntoView({ block: 'center', behavior: 'smooth' });
      target.classList.add('flash');
      setTimeout(function () { target.classList.remove('flash'); }, 1200);
    });
    return box;
  }

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
    watchLikes();
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
        restoring = true;
        requestAnimationFrame(function () {
          render();
          els.messages.scrollTop = els.messages.scrollHeight - before;
          stuck = false;
          requestAnimationFrame(function () { restoring = false; });
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
    var tags = [['e', CHANNEL_ID, RELAYS[0], 'root']];
    if (replyTo) {
      tags.push(['e', replyTo.id, RELAYS[0], 'reply']);
      tags.push(['p', replyTo.pubkey]);
    }
    auth.signEvent({
      kind: 42,
      created_at: Math.floor(Date.now() / 1000),
      tags: tags,
      content: content
    }).then(function (ev) {
      if (!NT.verifyEvent(ev)) throw new Error('Signature check failed');
      els.input.value = '';
      replyTo = null;
      drawReplyBar();
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
    if (!loggedIn) { replyTo = null; drawReplyBar(); }
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
