/* Who moderates, and what they decided.
 *
 * Moderators: a NIP-51 people set (kind 30000) published by the admin key with
 * d = semrede-moderators. Everyone on it can mute accounts, pin threads and
 * close threads, exactly like the admin.
 *
 * Mute lists are the standard kind 10000 of each moderator, merged.
 *
 * Pinned and closed threads: kind 30078 (app data) with d = semrede-forum-state,
 * one per moderator, merged. A thread is pinned or closed when any moderator
 * says so. Removing it from your own list only undoes your own decision.
 */
(function () {
  'use strict';

  var cfg = window.SemRedeConfig;
  var net = window.SemRedeNet;
  var auth = window.SemRedeNostr;
  var MOD_LIST_KIND = 30000;
  var STATE_KIND = 30078;
  var MOD_D = 'semrede-moderators';
  var STATE_D = 'semrede-forum-state';

  var moderators = [cfg.ADMIN_PUBKEY];
  var modListAt = 0;
  var states = new Map();      // pubkey -> {at, pinned:Set, closed:Set}
  var pinned = new Set();
  var closed = new Set();
  var listeners = [];
  var watching = false;

  function emit() {
    listeners.forEach(function (fn) { fn(); });
  }

  function tagValue(ev, name) {
    for (var i = 0; i < ev.tags.length; i++) if (ev.tags[i][0] === name) return ev.tags[i][1];
    return '';
  }

  function recompute() {
    pinned = new Set();
    closed = new Set();
    states.forEach(function (state, pubkey) {
      if (!isModerator(pubkey)) return;    // a demoted moderator stops counting
      state.pinned.forEach(function (id) { pinned.add(id); });
      state.closed.forEach(function (id) { closed.add(id); });
    });
    emit();
  }

  function applyModList(ev) {
    if (ev.pubkey !== cfg.ADMIN_PUBKEY || tagValue(ev, 'd') !== MOD_D || ev.created_at <= modListAt) return;
    modListAt = ev.created_at;
    var list = ev.tags.filter(function (t) { return t[0] === 'p' && /^[0-9a-f]{64}$/.test(t[1]); })
      .map(function (t) { return t[1]; });
    moderators = [cfg.ADMIN_PUBKEY].concat(list.filter(function (pk) { return pk !== cfg.ADMIN_PUBKEY; }));
    net.watchMuteList(moderators);
    watchState();
    recompute();
  }

  function applyState(ev) {
    if (tagValue(ev, 'd') !== STATE_D) return;
    var current = states.get(ev.pubkey);
    if (current && current.at >= ev.created_at) return;
    var data = {};
    try { data = JSON.parse(ev.content) || {}; } catch (e) { data = {}; }
    states.set(ev.pubkey, {
      at: ev.created_at,
      pinned: new Set(Array.isArray(data.pinned) ? data.pinned : []),
      closed: new Set(Array.isArray(data.closed) ? data.closed : [])
    });
    recompute();
  }

  function isModerator(pubkey) {
    return !!pubkey && moderators.indexOf(pubkey) !== -1;
  }

  function watchState() {
    net.pool.subscribeMany(net.RELAYS, { kinds: [STATE_KIND], authors: moderators, '#d': [STATE_D] }, {
      onevent: applyState
    });
  }

  function watch() {
    if (watching) return;
    watching = true;
    net.pool.subscribeMany(net.RELAYS, { kinds: [MOD_LIST_KIND], authors: [cfg.ADMIN_PUBKEY], '#d': [MOD_D] }, {
      onevent: applyModList
    });
    net.watchMuteList(moderators);
    watchState();
  }

  // ---- actions, all of them ordinary signed events ----

  function myState() {
    var mine = auth.pubkey && states.get(auth.pubkey);
    return {
      pinned: new Set(mine ? mine.pinned : []),
      closed: new Set(mine ? mine.closed : [])
    };
  }

  function publishState(state) {
    return auth.signEvent({
      kind: STATE_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['d', STATE_D]],
      content: JSON.stringify({ pinned: Array.from(state.pinned), closed: Array.from(state.closed) })
    }).then(function (ev) {
      applyState(ev);
      return net.publish(ev);
    });
  }

  function setPinned(threadId, on) {
    var state = myState();
    if (on) state.pinned.add(threadId); else state.pinned.delete(threadId);
    return publishState(state);
  }

  function setClosed(threadId, on) {
    var state = myState();
    if (on) state.closed.add(threadId); else state.closed.delete(threadId);
    return publishState(state);
  }

  // The mute list is this moderator's own kind 10000; it hides the account
  // across the chat, the forum and the messages of everyone using this site.
  function setMuted(pubkey, on) {
    return net.pool.get(net.RELAYS, { kinds: [10000], authors: [auth.pubkey] }, { maxWait: 4000 })
      .then(function (ev) {
        var tags = (ev && ev.tags ? ev.tags : []).filter(function (t) { return !(t[0] === 'p' && t[1] === pubkey); });
        if (on) tags.push(['p', pubkey]);
        return auth.signEvent({ kind: 10000, created_at: Math.floor(Date.now() / 1000), tags: tags, content: (ev && ev.content) || '' });
      })
      .then(function (signed) {
        net.applyMuteEvent(signed);
        return net.publish(signed);
      });
  }

  // Admin only: the moderator team itself.
  function setModerators(pubkeys) {
    return auth.signEvent({
      kind: MOD_LIST_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['d', MOD_D], ['title', 'SemRede moderators']]
        .concat(pubkeys.map(function (pk) { return ['p', pk]; })),
      content: ''
    }).then(function (ev) {
      applyModList(ev);
      return net.publish(ev);
    });
  }

  window.SemRedeMod = {
    watch: watch,
    isModerator: isModerator,
    isAdmin: function (pubkey) { return pubkey === cfg.ADMIN_PUBKEY; },
    moderators: function () { return moderators.slice(); },
    isPinned: function (id) { return pinned.has(id); },
    pinnedIds: function () { return Array.from(pinned); },
    closedIds: function () { return Array.from(closed); },
    isClosed: function (id) { return closed.has(id); },
    setPinned: setPinned,
    setClosed: setClosed,
    setMuted: setMuted,
    setModerators: setModerators,
    onChange: function (fn) { listeners.push(fn); }
  };
})();
