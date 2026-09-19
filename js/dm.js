/* Private messages, NIP-17 style: a kind 14 chat message is sealed (kind 13)
 * and gift wrapped (kind 1059) with a throwaway key, so relays see only the
 * recipient. Encryption is NIP-44, through window.nostr, which works both with
 * a browser extension and with the local key from nostr-login.js.
 *
 * Every message is wrapped twice, once for the other person and once for the
 * sender, so both sides can read the conversation later.
 */
(function () {
  'use strict';

  var NT = window.NostrTools;
  var net = window.SemRedeNet;
  var auth = window.SemRedeNostr;
  var GIFT_WRAP = 1059;
  var SEAL = 13;
  var CHAT = 14;
  var READ_KEY = 'semrede_dm_read';

  var messages = new Map();   // rumor id -> {id, peer, from, to, content, created_at, mine}
  var listeners = [];
  var seenWraps = new Set();
  var started = false;

  // Timestamps are fuzzed up to two days into the past, as NIP-59 asks, so the
  // relay cannot line up a seal with the wrap that carries it.
  function fuzzyNow() {
    return Math.floor(Date.now() / 1000) - Math.floor(Math.random() * 172800);
  }

  function readMap() {
    try { return JSON.parse(localStorage.getItem(READ_KEY) || '{}') || {}; } catch (e) { return {}; }
  }

  function writeMap(map) {
    try { localStorage.setItem(READ_KEY, JSON.stringify(map)); } catch (e) { /* private mode */ }
  }

  function emit() {
    listeners.forEach(function (fn) { fn(); });
  }

  function add(rumor, peer) {
    if (!rumor || rumor.kind !== CHAT || messages.has(rumor.id)) return;
    var mine = rumor.pubkey === auth.pubkey;
    messages.set(rumor.id, {
      id: rumor.id,
      peer: peer,
      from: rumor.pubkey,
      content: String(rumor.content || ''),
      created_at: rumor.created_at,
      mine: mine
    });
    net.requestProfile(peer);
    emit();
  }

  function unwrap(wrap) {
    if (seenWraps.has(wrap.id)) return Promise.resolve();
    seenWraps.add(wrap.id);
    return auth.decryptFrom(wrap.pubkey, wrap.content).then(function (sealJson) {
      var seal = JSON.parse(sealJson);
      if (seal.kind !== SEAL || !NT.verifyEvent(seal)) throw new Error('bad seal');
      return auth.decryptFrom(seal.pubkey, seal.content).then(function (rumorJson) {
        var rumor = JSON.parse(rumorJson);
        if (rumor.pubkey !== seal.pubkey) throw new Error('rumor does not match seal');
        // The conversation partner: the other end of this message.
        var to = (rumor.tags || []).filter(function (t) { return t[0] === 'p'; }).map(function (t) { return t[1]; })[0];
        var peer = rumor.pubkey === auth.pubkey ? (to || auth.pubkey) : rumor.pubkey;
        if (!rumor.id) rumor.id = NT.getEventHash(rumor);
        add(rumor, peer);
      });
    }).catch(function () { /* not for us, or from a client we cannot read */ });
  }

  function wrapFor(seal, recipient) {
    var ephemeral = NT.generateSecretKey();
    var key = NT.nip44.getConversationKey(ephemeral, recipient);
    return NT.finalizeEvent({
      kind: GIFT_WRAP,
      created_at: fuzzyNow(),
      tags: [['p', recipient]],
      content: NT.nip44.encrypt(JSON.stringify(seal), key)
    }, ephemeral);
  }

  function send(peerPubkey, text) {
    if (!auth.pubkey) return Promise.reject(new Error('Not logged in'));
    if (!auth.canEncrypt()) return Promise.reject(new Error('This login cannot encrypt messages'));
    var content = String(text || '').trim();
    if (!content) return Promise.reject(new Error('Empty message'));

    var rumor = {
      pubkey: auth.pubkey,
      created_at: Math.floor(Date.now() / 1000),
      kind: CHAT,
      tags: [['p', peerPubkey]],
      content: content
    };
    rumor.id = NT.getEventHash(rumor);

    // One seal per recipient: the seal is encrypted to that reader.
    var targets = peerPubkey === auth.pubkey ? [auth.pubkey] : [peerPubkey, auth.pubkey];
    return Promise.all(targets.map(function (target) {
      return auth.encryptFor(target, JSON.stringify(rumor)).then(function (sealed) {
        return auth.signEvent({ kind: SEAL, created_at: fuzzyNow(), tags: [], content: sealed })
          .then(function (seal) { return net.publish(wrapFor(seal, target)); });
      });
    })).then(function (results) {
      if (!results.some(Boolean)) throw new Error('No relay accepted the message');
      add(rumor, peerPubkey);
      return rumor;
    });
  }

  // Subscribing needs no key material: the wraps are addressed to our pubkey.
  function start() {
    if (started || !auth.pubkey) return;
    started = true;
    net.pool.subscribeMany(net.RELAYS, { kinds: [GIFT_WRAP], '#p': [auth.pubkey], limit: 400 }, {
      onevent: unwrap
    });
  }

  function conversations() {
    var byPeer = new Map();
    messages.forEach(function (m) {
      if (net.isMuted(m.from)) return;
      var c = byPeer.get(m.peer);
      if (!c) {
        c = { peer: m.peer, messages: [], last: 0, unread: 0 };
        byPeer.set(m.peer, c);
      }
      c.messages.push(m);
      if (m.created_at > c.last) c.last = m.created_at;
    });
    var read = readMap();
    var list = Array.from(byPeer.values());
    list.forEach(function (c) {
      c.messages.sort(function (a, b) { return a.created_at - b.created_at; });
      var since = read[c.peer] || 0;
      c.unread = c.messages.filter(function (m) { return !m.mine && m.created_at > since; }).length;
    });
    list.sort(function (a, b) { return b.last - a.last; });
    return list;
  }

  function unreadTotal() {
    return conversations().reduce(function (n, c) { return n + c.unread; }, 0);
  }

  function markRead(peer) {
    var map = readMap();
    var newest = 0;
    messages.forEach(function (m) { if (m.peer === peer && m.created_at > newest) newest = m.created_at; });
    map[peer] = Math.max(map[peer] || 0, newest, Math.floor(Date.now() / 1000));
    writeMap(map);
    emit();
  }

  window.SemRedeDM = {
    start: start,
    send: send,
    conversations: conversations,
    unreadTotal: unreadTotal,
    markRead: markRead,
    onChange: function (fn) { listeners.push(fn); },
    messagesFor: function (peer) {
      return conversations().filter(function (c) { return c.peer === peer; })[0] || { peer: peer, messages: [], unread: 0 };
    }
  };

  document.addEventListener('semrede-login', start);
  if (auth.pubkey) start();
  auth.ready.then(start);
})();
