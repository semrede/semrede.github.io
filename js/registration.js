/* /registration: NIP-52 RSVPs (kind 31925) to the two calendar events of
 * SemRede 2026. Answers are public NOSTR events, which is also what makes the
 * counters possible: anyone can count them, here or in any other client.
 *
 * "I'm going" is status accepted, "I'm interested" is tentative, and changing
 * the answer replaces the old one (the RSVP is addressable, one per person and
 * event through its d tag).
 */
(function () {
  'use strict';

  var NT = window.NostrTools;
  var cfg = window.SemRedeConfig;
  var net = window.SemRedeNet;
  var auth = window.SemRedeNostr;
  var RSVP_KIND = 31925;
  var COMMENT_MAX = 500;

  var $ = function (id) { return document.getElementById(id); };
  var els = {
    parts: $('reg-parts'), comment: $('reg-comment'), commentRow: $('reg-comment-row'),
    save: $('reg-save'), status: $('reg-status'), locked: $('reg-locked'),
    counts: $('reg-counts'), relayDots: $('relay-dots')
  };

  // pubkey -> { slug -> { status, comment, created_at } }
  var rsvps = new Map();
  var commentTouched = false;
  var loaded = false;

  // Always read our own answers out of the same data the counters use, so a
  // reload shows them even though the login is restored after the first events.
  function myRsvp(slug) {
    var person = auth.pubkey && rsvps.get(auth.pubkey);
    return (person && person[slug]) || null;
  }

  function myComment() {
    var person = auth.pubkey && rsvps.get(auth.pubkey);
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

  function tagValue(ev, name) {
    for (var i = 0; i < ev.tags.length; i++) if (ev.tags[i][0] === name) return ev.tags[i][1];
    return '';
  }

  function slugForCoord(coord) {
    var match = cfg.EVENTS.filter(function (e) { return e.coord === coord; })[0];
    return match ? match.slug : null;
  }

  function addRsvp(ev) {
    var slug = slugForCoord(tagValue(ev, 'a'));
    var status = tagValue(ev, 'status');
    if (!slug || ['accepted', 'tentative', 'declined'].indexOf(status) === -1) return;
    var person = rsvps.get(ev.pubkey) || {};
    var old = person[slug];
    if (old && old.created_at >= ev.created_at) return;
    person[slug] = { status: status, comment: ev.content || '', created_at: ev.created_at };
    rsvps.set(ev.pubkey, person);
    net.requestProfile(ev.pubkey);
    render();
  }

  function tally(slug) {
    var going = 0, interested = 0;
    rsvps.forEach(function (person, pubkey) {
      if (net.isMuted(pubkey)) return;
      var r = person[slug];
      if (!r) return;
      if (r.status === 'accepted') going++;
      else if (r.status === 'tentative') interested++;
    });
    return { going: going, interested: interested };
  }

  function peopleGoing() {
    var set = new Set();
    rsvps.forEach(function (person, pubkey) {
      if (net.isMuted(pubkey)) return;
      cfg.EVENTS.forEach(function (e) {
        var r = person[e.slug];
        if (r && r.status === 'accepted') set.add(pubkey);
      });
    });
    return set.size;
  }

  // ---------- rendering ----------

  function render() {
    renderParts();
    renderCounts();
    if (!commentTouched && document.activeElement !== els.comment) els.comment.value = myComment();
  }

  function renderParts() {
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
      numbers.textContent = loaded
        ? counts.going + (counts.going === 1 ? ' person going' : ' people going') + ', ' + counts.interested + ' interested'
        : 'Counting...';

      var buttons = document.createElement('div');
      buttons.className = 'reg-buttons';
      [['accepted', "I'm going"], ['tentative', "I'm interested"], ['declined', 'Not this time']].forEach(function (pair) {
        var b = document.createElement('button');
        b.type = 'button';
        var current = myRsvp(ev.slug);
        b.className = 'reg-btn' + (current && current.status === pair[0] ? ' chosen' : '');
        b.dataset.slug = ev.slug;
        b.dataset.status = pair[0];
        b.textContent = pair[1];
        b.disabled = !auth.pubkey;
        b.addEventListener('click', function () { choose(ev.slug, pair[0]); });
        buttons.appendChild(b);
      });

      card.append(head, about, numbers, buttons);
      els.parts.appendChild(card);
    });
  }

  function renderCounts() {
    els.counts.textContent = '';
    var total = document.createElement('div');
    total.className = 'count-box total';
    total.append(bigNumber(loaded ? peopleGoing() : null), label('people going'));
    els.counts.appendChild(total);

    cfg.EVENTS.forEach(function (ev) {
      var counts = tally(ev.slug);
      var box = document.createElement('div');
      box.className = 'count-box';
      box.append(bigNumber(loaded ? counts.going : null), label(ev.slug === 'eva' ? 'at Eva Farm' : 'at Embaixada'));
      var extra = document.createElement('span');
      extra.className = 'count-extra';
      extra.textContent = loaded ? '+ ' + counts.interested + ' interested' : '';
      box.appendChild(extra);
      els.counts.appendChild(box);
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

  function choose(slug, value) {
    if (!auth.pubkey) return;
    publishRsvp(slug, value, els.comment.value.trim().slice(0, COMMENT_MAX));
  }

  function publishRsvp(slug, value, comment) {
    var ev = eventBySlug(slug);
    status('Saving...');
    return auth.signEvent({
      kind: RSVP_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['d', 'semrede-2026-' + slug],
        ['a', ev.coord],
        ['e', ev.id],
        ['status', value],
        ['p', cfg.ADMIN_PUBKEY]
      ],
      content: comment || ''
    }).then(function (signed) {
      if (!NT.verifyEvent(signed)) throw new Error('Signature check failed');
      addRsvp(signed);
      return net.publish(signed);
    }).then(function (ok) {
      if (!ok) throw new Error('No relay accepted your answer');
      status(value === 'declined' ? 'Marked as not coming.' : 'Saved. Thank you.', 'ok');
    }).catch(function (err) {
      status(err.message || 'Could not save your answer', 'bad');
    });
  }

  function saveComment() {
    var comment = els.comment.value.trim().slice(0, COMMENT_MAX);
    var answered = cfg.EVENTS.map(function (e) { return e.slug; }).filter(function (slug) {
      var r = myRsvp(slug);
      return r && r.status !== 'declined';
    });
    if (!answered.length) return status('Pick a part of the event first.', 'bad');
    commentTouched = false;
    Promise.all(answered.map(function (slug) { return publishRsvp(slug, myRsvp(slug).status, comment); }))
      .then(function () { status('Saved. Thank you.', 'ok'); });
  }

  // ---------- relay traffic ----------

  function watch() {
    var coords = cfg.EVENTS.map(function (e) { return e.coord; });
    net.pool.subscribeMany(net.RELAYS, { kinds: [RSVP_KIND], '#a': coords, limit: 2000 }, {
      onevent: addRsvp,
      oneose: function () { loaded = true; render(); }
    });
    setTimeout(function () { loaded = true; render(); }, 8000);
    net.watchMuteList();
  }

  function onLoginChange() {
    var loggedIn = !!auth.pubkey;
    els.locked.hidden = loggedIn;
    els.commentRow.hidden = !loggedIn;
    render();
  }

  els.comment.addEventListener('input', function () { commentTouched = true; });
  els.save.addEventListener('click', saveComment);
  document.addEventListener('semrede-login', onLoginChange);
  document.addEventListener('semrede-logout', function () { commentTouched = false; els.comment.value = ''; onLoginChange(); });
  net.onProfile(function () { render(); });
  net.onMuteChange(render);
  auth.ready.then(onLoginChange);

  onLoginChange();
  watch();
  net.relayStatus(els.relayDots, null);
})();
