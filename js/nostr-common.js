/* Pieces shared by chat.js and forum.js: the relay pool, profile lookups,
 * the admin mute list, relay status dots and the text helpers.
 */
(function () {
  'use strict';

  var NT = window.NostrTools;
  var cfg = window.SemRedeConfig;
  var auth = window.SemRedeNostr;
  var session = window.SemRedeSession;
  var RELAYS = cfg.RELAYS;
  var pool = new NT.SimplePool({ enablePing: true, enableReconnect: true });

  // ---- profiles (kind 0) ----
  var profiles = new Map();
  var requested = new Set();
  var batch = new Set();
  var batchTimer = null;
  var profileListeners = [];

  function applyProfile(ev) {
    var old = profiles.get(ev.pubkey);
    if (old && old.created_at >= ev.created_at) return;
    var data;
    try { data = JSON.parse(ev.content) || {}; } catch (e) { return; }
    var name = String(data.display_name || data.name || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    var picture = typeof data.picture === 'string' && /^https:\/\//.test(data.picture) ? data.picture : '';
    profiles.set(ev.pubkey, { name: name, picture: picture, created_at: ev.created_at, raw: data });
    // Our own profile is kept in this browser, so the next page can draw the
    // header without waiting for a relay.
    if (session && ev.pubkey === auth.pubkey) {
      session.saveProfile({ name: name, picture: picture, at: ev.created_at });
    }
    profileListeners.forEach(function (fn) { fn(ev.pubkey); });
  }

  // Start from what this browser already knows about the visitor, so names and
  // avatars do not appear as a callsign first and change a moment later.
  if (session && session.pubkey) {
    var cached = session.profile();
    if (cached && (cached.name || cached.picture)) {
      profiles.set(session.pubkey, {
        name: cached.name, picture: cached.picture, created_at: cached.at || 0, raw: {}
      });
    }
  }

  function requestProfile(pubkey) {
    if (requested.has(pubkey)) return;
    requested.add(pubkey);
    batch.add(pubkey);
    clearTimeout(batchTimer);
    batchTimer = setTimeout(function () {
      var authors = Array.from(batch);
      batch.clear();
      if (!authors.length) return;
      pool.subscribeManyEose(RELAYS, { kinds: [0], authors: authors }, { onevent: applyProfile });
    }, 250);
  }

  // ---- mute lists (NIP-51 kind 10000) of the admin and the moderators ----
  var muted = new Set();
  var muteListeners = [];

  // Mute lists of the admin and of every moderator, merged: anyone on any of
  // them is hidden on this site. Kept per author so removing someone from one
  // list does not resurrect them on another.
  var muteLists = new Map();   // pubkey -> {at, set}

  function applyMuteEvent(ev) {
    var current = muteLists.get(ev.pubkey);
    if (current && current.at >= ev.created_at) return;
    muteLists.set(ev.pubkey, {
      at: ev.created_at,
      set: new Set(ev.tags.filter(function (t) { return t[0] === 'p'; }).map(function (t) { return t[1]; }))
    });
    muted = new Set();
    muteLists.forEach(function (entry) { entry.set.forEach(function (pk) { muted.add(pk); }); });
    muteListeners.forEach(function (fn) { fn(); });
  }

  function watchMuteList(authors) {
    var list = authors && authors.length ? authors : [cfg.ADMIN_PUBKEY];
    pool.subscribeMany(RELAYS, { kinds: [10000], authors: list }, { onevent: applyMuteEvent });
  }

  // ---- text ----
  var IMAGE_RE = /\.(jpe?g|png|gif|webp|avif)(\?[^\s]*)?$/i;

  function imageNode(url) {
    var fig = document.createElement('figure');
    fig.className = 'post-image';
    var a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener nofollow ugc';
    var img = document.createElement('img');
    img.src = url;
    img.alt = '';
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    img.onerror = function () {
      // fall back to a plain link if the media server is gone
      var link = document.createElement('a');
      link.href = url;
      link.textContent = url;
      link.target = '_blank';
      link.rel = 'noopener nofollow ugc';
      fig.replaceWith(link);
    };
    a.appendChild(img);
    fig.appendChild(a);
    return fig;
  }

  function renderText(container, text) {
    var re = /https?:\/\/[^\s<>"']+/g;
    var last = 0, m;
    while ((m = re.exec(text))) {
      var url = m[0].replace(/[.,!?;:)\]]+$/, '');
      if (m.index > last) container.appendChild(document.createTextNode(text.slice(last, m.index)));
      if (IMAGE_RE.test(url)) {
        container.appendChild(imageNode(url));
      } else {
        var a = document.createElement('a');
        a.href = url;
        a.textContent = url;
        a.target = '_blank';
        a.rel = 'noopener nofollow ugc';
        container.appendChild(a);
      }
      last = m.index + url.length;
    }
    if (last < text.length) container.appendChild(document.createTextNode(text.slice(last)));
  }

  // Dates follow whatever language the translation overlay settled on.
  function locale() {
    return document.documentElement.lang === 'pt' ? 'pt-PT' : 'en-GB';
  }

  function timeLabel(ts) {
    return new Date(ts * 1000).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });
  }

  function dayLabel(ts) {
    var d = new Date(ts * 1000);
    var today = new Date();
    if (d.toDateString() === today.toDateString()) return 'Today';
    if (d.toDateString() === new Date(Date.now() - 864e5).toDateString()) return 'Yesterday';
    return d.toLocaleDateString(locale(), {
      weekday: 'long', day: 'numeric', month: 'long',
      year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric'
    });
  }

  // "3 minutes ago", for lists where the exact minute does not matter.
  function ago(ts) {
    var s = Math.max(1, Math.floor(Date.now() / 1000 - ts));
    var steps = [[60, 'second'], [60, 'minute'], [24, 'hour'], [7, 'day'], [4.34, 'week'], [12, 'month']];
    var value = s, unit = 'second';
    for (var i = 0; i < steps.length && value >= steps[i][0]; i++) {
      value = value / steps[i][0];
      unit = steps[i + 1] ? steps[i + 1][1] : 'year';
    }
    value = Math.floor(value);
    return value + ' ' + unit + (value === 1 ? '' : 's') + ' ago';
  }

  // ---- people ----
  function displayName(pubkey) {
    var p = profiles.get(pubkey);
    return (p && p.name) || auth.deriveCallsign(pubkey);
  }

  // Same colour here and in the header; js/session.js owns it.
  function colorFor(pubkey) {
    return session ? session.colorFor(pubkey) : 'var(--teal)';
  }

  function fillAvatar(el, pubkey) {
    el.textContent = '';
    el.style.setProperty('--avatar', colorFor(pubkey));
    var p = profiles.get(pubkey);
    var fallback = displayName(pubkey).replace(/^X1/, '').trim().slice(0, 2).toUpperCase();
    if (p && p.picture) {
      var img = document.createElement('img');
      img.src = p.picture;
      img.alt = '';
      img.loading = 'lazy';
      img.referrerPolicy = 'no-referrer';
      img.onerror = function () { img.remove(); el.textContent = fallback; };
      el.appendChild(img);
    } else {
      el.textContent = fallback;
    }
  }

  // ---- relays ----
  function relayStatus(dotsEl, countEl) {
    function update() {
      var status = pool.listConnectionStatus();
      var up = 0;
      dotsEl.textContent = '';
      RELAYS.forEach(function (url) {
        var ok = status.get(url) || status.get(url + '/');
        if (ok) up++;
        var dot = document.createElement('i');
        dot.className = ok ? 'up' : 'down';
        dot.title = url.replace('wss://', '') + (ok ? ' connected' : ' offline');
        dotsEl.appendChild(dot);
      });
      if (countEl) countEl.textContent = up + '/' + RELAYS.length + ' relays';
    }
    update();
    setInterval(update, 4000);
  }

  function publish(event) {
    return Promise.allSettled(pool.publish(RELAYS, event)).then(function (results) {
      return results.some(function (r) { return r.status === 'fulfilled'; });
    });
  }

  window.SemRedeNet = {
    pool: pool, RELAYS: RELAYS, publish: publish,
    profiles: profiles, requestProfile: requestProfile, applyProfile: applyProfile,
    onProfile: function (fn) { profileListeners.push(fn); },
    isMuted: function (pubkey) { return muted.has(pubkey); },
    onMuteChange: function (fn) { muteListeners.push(fn); },
    watchMuteList: watchMuteList,
    applyMuteEvent: applyMuteEvent,
    mutedList: function () { return Array.from(muted); },
    renderText: renderText, timeLabel: timeLabel, dayLabel: dayLabel, ago: ago,
    displayName: displayName, colorFor: colorFor, fillAvatar: fillAvatar,
    relayStatus: relayStatus
  };
})();
