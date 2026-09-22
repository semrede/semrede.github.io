/* The visit numbers on /stats.
 *
 * There is nothing scheduled anywhere. The beacons are encrypted to the admin
 * key, so when an organizer opens this page their own browser reads them off
 * the relays, decrypts them, counts them, and publishes the day for the
 * moderation team. A moderator who is not the admin reads those published days
 * instead, and cannot read a single raw beacon.
 *
 * Aggregates are accepted only from the admin key or from the stats key that
 * published the first days, so nobody can forge a day.
 */
(function () {
  'use strict';

  var cfg = window.SemRedeConfig;
  var S = window.SemRedeStatsSchema;
  var net = window.SemRedeNet;
  var auth = window.SemRedeNostr;
  var mod = window.SemRedeMod;

  var els = {
    section: document.getElementById('stats-section'),
    body: document.getElementById('stats-body'),
    gate: document.getElementById('stats-gate'),
    desk: document.getElementById('stats-desk'),
    role: document.getElementById('stats-role'),
    dots: document.getElementById('relay-dots')
  };
  if (!els.section || !cfg || !cfg.STATS || !S) return;

  var days = new Map();     // 'YYYY-MM-DD' -> {at, data, mine}
  var watching = false;
  var reading = false;      // busy decrypting beacons
  var status = '';          // what to say about where the numbers come from
  var PUB_KEY = 'semrede_stats_published';   // day -> what this browser last sent
  var current = null;       // the bucket key being shown below the chart
  var picked = false;       // true once somebody chose a bucket themselves
  var grain = 'day';        // day | week | month | year

  // A page opened by a test can hand the card a set of days, so the chart can
  // be looked at without waiting for a month of real traffic. Never set by the
  // site itself.
  if (window.SemRedeStatsFixture) {
    Object.keys(window.SemRedeStatsFixture).forEach(function (day) {
      days.set(day, { at: 0, data: window.SemRedeStatsFixture[day] });
    });
  }

  function apply(ev) {
    var d = (ev.tags.filter(function (t) { return t[0] === 'd'; })[0] || [])[1] || '';
    if (d.indexOf(S.AGG_D_PREFIX) !== 0) return;
    auth.decryptFrom(ev.pubkey, ev.content).then(function (json) {
      var data;
      try { data = JSON.parse(json); } catch (e) { return; }
      if (!data || !data.day) return;
      var known = days.get(data.day);
      if (known && (known.mine || known.at >= ev.created_at)) return;
      days.set(data.day, { at: ev.created_at, data: data });
      if (!current) current = data.day;
      render();
    }, function () { /* not for this key */ });
  }

  function watch() {
    if (watching || !auth.pubkey) return;
    watching = true;
    var authors = [cfg.ADMIN_PUBKEY];
    if (cfg.STATS.LEGACY_PUBKEY) authors.push(cfg.STATS.LEGACY_PUBKEY);
    net.pool.subscribeMany(net.RELAYS, {
      kinds: [S.RUMOR_KIND], authors: authors, '#p': [auth.pubkey], limit: 200
    }, { onevent: apply });
    if (canCount()) readBeacons();
  }

  // ---- the admin's browser does the counting ----

  // Its own pool: the shared one carries the long-lived subscriptions of the
  // chat, the messages and the moderation lists, and asking it for beacons on
  // the relay those subscriptions live on came back empty every time, while a
  // fresh connection to the same relay returned them all.
  var beaconPool = null;
  function pool() {
    if (!beaconPool) beaconPool = new window.NostrTools.SimplePool();
    return beaconPool;
  }

  var CACHE_KEY = 'semrede_stats_read';
  var CHUNK = 25;           // an extension answers one decrypt at a time
  var MAX_PER_VISIT = 1500;

  function cache() {
    try { return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}') || {}; } catch (e) { return {}; }
  }

  function saveCache(map) {
    var cutoff = Math.floor(Date.now() / 1000) - 45 * 86400;
    var out = {};
    Object.keys(map).forEach(function (id) { if (map[id].at > cutoff) out[id] = map[id]; });
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(out)); } catch (e) { /* full or private */ }
    return out;
  }

  function countFromCache(map) {
    var byDay = {};
    Object.keys(map).forEach(function (id) {
      var row = map[id];
      var day = S.dayOf(row.at);
      (byDay[day] = byDay[day] || []).push({ id: id, at: row.at, p: row.p });
    });
    Object.keys(byDay).forEach(function (day) {
      var counted = S.aggregate(day, byDay[day]);
      var known = days.get(day);
      // A published day that is bigger stays: this browser only sees the last
      // thirty days, only what the relays still hold, and only what it had time
      // to decrypt, so a smaller number here means missing beacons, not fewer
      // visits.
      if (known && !known.mine && known.data && known.data.views > counted.views) return;
      days.set(day, { at: Math.floor(Date.now() / 1000), data: counted, mine: true });
    });
    return Object.keys(byDay);
  }

  // Whoever is listed as a reader of the beacons can do the counting here.
  function canCount() {
    var readers = cfg.STATS.READERS || [cfg.STATS.PUBKEY];
    return !!auth.pubkey && readers.indexOf(auth.pubkey) !== -1;
  }

  function readBeacons() {
    if (reading || !canCount()) return;
    reading = true;
    status = 'Looking for beacons...';
    render();

    var since = Math.floor(Date.now() / 1000) - 30 * 86400;
    // Ask every relay, not only the two the beacons are sent to: a relay that
    // will not answer must not be able to hide a day.
    var relays = (cfg.STATS.RELAYS || []).concat(net.RELAYS).filter(function (url, i, all) {
      return all.indexOf(url) === i;
    });
    pool().querySync(relays, {
      kinds: [S.RUMOR_KIND], '#p': [auth.pubkey], '#d': [S.BEACON_D], since: since, limit: 5000
    }, { maxWait: 9000 }).then(function (events) {
      var known = cache();
      var fresh = events.filter(function (ev) {
        return ev.kind === S.RUMOR_KIND && !known[ev.id] && ev.content.length <= S.MAX_BYTES * 3;
      }).sort(function (a, b) { return b.created_at - a.created_at; }).slice(0, MAX_PER_VISIT);

      if (!fresh.length) {
        countFromCache(known);
        reading = false;
        status = '';
        render();
        return publishDays();
      }

      var done = 0;
      function step() {
        var batch = fresh.slice(done, done + CHUNK);
        if (!batch.length) {
          known = saveCache(known);
          countFromCache(known);
          reading = false;
          status = '';
          render();
          return publishDays();
        }
        status = 'Reading ' + (done + batch.length) + ' of ' + fresh.length + ' beacons...';
        render();
        Promise.all(batch.map(function (ev) {
          return auth.decryptFrom(ev.pubkey, ev.content).then(function (json) {
            var payload;
            try { payload = S.validate(JSON.parse(json)); } catch (e) { payload = null; }
            if (payload) known[ev.id] = { at: ev.created_at, p: payload };
          }, function () { /* not ours, or a forgery */ });
        })).then(function () {
          done += batch.length;
          step();
        });
      }
      step();
    }, function () {
      reading = false;
      status = 'The relays did not answer. Try again in a moment.';
      render();
    });
  }

  // Hand the day to the moderators, who cannot read a raw beacon. Throttled
  // across visits, so opening the page repeatedly does not republish the same
  // numbers to everybody.
  function publishedLog() {
    try { return JSON.parse(localStorage.getItem(PUB_KEY) || '{}') || {}; } catch (e) { return {}; }
  }

  function publishDays() {
    if (!canCount()) return;
    var now = Date.now();
    var recipients = mod.moderators();
    var log = publishedLog();
    Array.from(days.keys()).sort().slice(-3).forEach(function (day) {
      var entry = days.get(day);
      if (!entry || !entry.data) return;
      var fingerprint = day + ':' + entry.data.views + ':' + entry.data.visits + ':' + recipients.length;
      var last = log[day];
      if (last && last.fingerprint === fingerprint && now - last.at < 10 * 60 * 1000) return;
      log[day] = { fingerprint: fingerprint, at: now };
      try { localStorage.setItem(PUB_KEY, JSON.stringify(log)); } catch (e) { /* private mode */ }
      recipients.forEach(function (pk) {
        auth.encryptFor(pk, JSON.stringify(entry.data)).then(function (content) {
          return auth.signEvent({
            kind: S.RUMOR_KIND,
            created_at: Math.floor(Date.now() / 1000),
            tags: [['d', S.AGG_D_PREFIX + day + '-' + pk.slice(0, 8)], ['p', pk], ['title', 'SemRede visits ' + day]],
            content: content
          });
        }).then(function (ev) { return net.publish(ev); }).catch(function () { /* said on the page */ });
      });
    });
  }

  // ---- putting days into buckets ----

  // The Monday of that day's week, which is what a week is called here.
  function mondayOf(day) {
    var d = new Date(day + 'T00:00:00Z');
    var back = (d.getUTCDay() + 6) % 7;
    d.setUTCDate(d.getUTCDate() - back);
    return d.toISOString().slice(0, 10);
  }

  function bucketOf(day, how) {
    if (how === 'week') return mondayOf(day);
    if (how === 'month') return day.slice(0, 7);
    if (how === 'year') return day.slice(0, 4);
    return day;
  }

  function bucketLabel(key, how) {
    if (how === 'week') return key.slice(8, 10) + '/' + key.slice(5, 7);
    if (how === 'month') return key.slice(5, 7) + '/' + key.slice(2, 4);
    if (how === 'year') return key;
    return key.slice(8, 10) + '/' + key.slice(5, 7);
  }

  function bucketTitle(key, how) {
    if (how === 'week') return 'week of ' + key;
    if (how === 'month') return key;
    if (how === 'year') return key;
    return key;
  }

  function addTables(into, from) {
    Object.keys(from || {}).forEach(function (name) {
      into[name] = (into[name] || 0) + from[name];
    });
  }

  // Everything in one bucket added together. Summing visits across days is
  // right by definition: a visit is one tab on one day.
  function merge(list) {
    var out = { views: 0, visits: 0, firstTime: 0, engaged: 0, beacons: 0, capped: 0, ungrouped: 0,
      paths: {}, refs: {}, langs: {}, screens: {}, secs: {}, days: list.length };
    list.forEach(function (d) {
      ['views', 'visits', 'firstTime', 'engaged', 'beacons', 'capped', 'ungrouped'].forEach(function (k) {
        out[k] += Number(d[k]) || 0;
      });
      ['paths', 'refs', 'langs', 'screens', 'secs'].forEach(function (k) { addTables(out[k], d[k]); });
    });
    return out;
  }

  function series(how) {
    var buckets = new Map();
    Array.from(days.keys()).sort().forEach(function (day) {
      var key = bucketOf(day, how);
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(days.get(day).data);
    });
    var limit = how === 'day' ? 30 : how === 'week' ? 26 : how === 'month' ? 24 : 12;
    return Array.from(buckets.keys()).sort().slice(-limit).map(function (key) {
      return { key: key, data: merge(buckets.get(key)) };
    });
  }

  // ---- the chart ----

  function chart(points) {
    var wrap = document.createElement('div');
    wrap.className = 'chart';
    var most = points.reduce(function (n, p) { return Math.max(n, p.data.views); }, 0) || 1;

    var plot = document.createElement('div');
    plot.className = 'chart-plot';
    points.forEach(function (point) {
      var column = document.createElement('button');
      column.type = 'button';
      column.className = 'chart-col' + (point.key === current ? ' current' : '');
      column.title = bucketTitle(point.key, grain) + ': ' + point.data.views + ' page views, ' + point.data.visits + ' visits';

      var bars = document.createElement('span');
      bars.className = 'chart-bars';
      var views = document.createElement('i');
      views.className = 'bar-views';
      views.style.height = Math.max(2, Math.round(point.data.views / most * 100)) + '%';
      var visits = document.createElement('i');
      visits.className = 'bar-visits';
      visits.style.height = Math.max(2, Math.round(point.data.visits / most * 100)) + '%';
      bars.append(views, visits);

      var label = document.createElement('span');
      label.className = 'chart-label';
      label.textContent = bucketLabel(point.key, grain);

      column.append(bars, label);
      column.addEventListener('click', function () { current = point.key; picked = true; render(); });
      plot.appendChild(column);
    });

    var legend = document.createElement('p');
    legend.className = 'chart-legend';
    var one = document.createElement('span');
    one.className = 'key-views';
    one.textContent = 'page views';
    var two = document.createElement('span');
    two.className = 'key-visits';
    two.textContent = 'visits';
    legend.append(one, two);

    wrap.append(plot, legend);
    return wrap;
  }

  function problem(text) {
    var box = document.createElement('p');
    box.className = 'muted-note stats-fresh stale';
    box.textContent = text;
    return box;
  }

  function topBar() {
    var bar = document.createElement('div');
    bar.className = 'stats-bar';
    if (canCount()) {
      var refresh = document.createElement('button');
      refresh.type = 'button';
      refresh.className = 'small-btn';
      refresh.textContent = 'Read the beacons again';
      refresh.disabled = reading;
      refresh.addEventListener('click', readBeacons);
      bar.appendChild(refresh);
    }
    if (status) {
      var note = document.createElement('span');
      note.className = 'stats-working';
      note.textContent = status;
      bar.appendChild(note);
    }
    return bar;
  }

  function grainSwitch() {
    var row = document.createElement('div');
    row.className = 'grain-row';
    [['day', 'Days'], ['week', 'Weeks'], ['month', 'Months'], ['year', 'Years']].forEach(function (pair) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'grain-btn' + (grain === pair[0] ? ' current' : '');
      button.textContent = pair[1];
      button.addEventListener('click', function () {
        grain = pair[0];
        current = null;
        picked = false;
        render();
      });
      row.appendChild(button);
    });
    return row;
  }

  function table(title, obj) {
    var rows = Object.keys(obj || {}).map(function (k) { return [k, obj[k]]; })
      .sort(function (a, b) { return b[1] - a[1]; });
    if (!rows.length) return null;
    var wrap = document.createElement('div');
    var h = document.createElement('h3');
    h.className = 'admin-h3';
    h.textContent = title;
    wrap.appendChild(h);
    var most = rows[0][1] || 1;
    rows.forEach(function (row) {
      var line = document.createElement('div');
      line.className = 'stat-row';
      var name = document.createElement('span');
      name.className = 'stat-name';
      name.textContent = row[0];
      var bar = document.createElement('span');
      bar.className = 'stat-bar';
      var fill = document.createElement('i');
      fill.style.width = Math.max(2, Math.round(row[1] / most * 100)) + '%';
      bar.appendChild(fill);
      var n = document.createElement('strong');
      n.textContent = String(row[1]);
      line.append(name, bar, n);
      wrap.appendChild(line);
    });
    return wrap;
  }

  function tile(number, label, extra) {
    var box = document.createElement('div');
    box.className = 'count-box';
    var big = document.createElement('strong');
    big.textContent = String(number);
    var small = document.createElement('span');
    small.className = 'count-label';
    small.textContent = label;
    box.append(big, small);
    if (extra) {
      var note = document.createElement('span');
      note.className = 'count-extra';
      note.textContent = extra;
      box.appendChild(note);
    }
    return box;
  }

  function render() {
    if (!els.body) return;
    var allowed = !!auth.pubkey && mod.isModerator(auth.pubkey);

    // On its own page the whole thing is gated, the way /admin is.
    if (els.gate) els.gate.hidden = allowed;
    if (els.desk) els.desk.hidden = !allowed;
    if (els.role) {
      els.role.textContent = !auth.pubkey ? ''
        : allowed ? (mod.isAdmin(auth.pubkey) ? 'You are the admin' : 'You are a moderator')
        : 'This key is not on the moderation team.';
    }

    els.body.textContent = '';
    if (!allowed) return;

    // Numbers are encrypted. A signer that cannot decrypt has to say so, or the
    // page looks empty and the reason is invisible.
    if (auth.signerState === 'lost') {
      els.body.appendChild(problem('Your NOSTR extension is not answering, so nothing here can be decrypted. Unlock it and reload, or log in with your key kept in this browser.'));
      return;
    }
    if (!auth.canEncrypt()) {
      els.body.appendChild(problem('This login cannot decrypt (the extension has no NIP-44 support), so the numbers cannot be read. Log in on /login with your key kept in this browser instead.'));
      return;
    }

    var all = Array.from(days.keys()).sort().reverse();
    if (!all.length) {
      var none = document.createElement('p');
      none.className = 'muted-note';
      none.textContent = canCount()
        ? 'No beacons found yet. They appear here as people read the site.'
        : 'No numbers yet. They appear once somebody who can read the beacons opens this page.';
      els.body.appendChild(none);
      return;
    }

    var points = series(grain);
    // Follow the newest bucket until somebody picks one, so a day arriving
    // mid-session does not leave the card sitting on yesterday.
    if (!picked || !current || !points.some(function (p) { return p.key === current; })) {
      current = points.length ? points[points.length - 1].key : null;
    }

    els.body.append(topBar(), grainSwitch(), chart(points));

    var picked = points.filter(function (p) { return p.key === current; })[0];
    if (!picked) return;
    var data = picked.data;

    var heading = document.createElement('h3');
    heading.className = 'admin-h3 bucket-title';
    heading.textContent = bucketTitle(current, grain);
    els.body.appendChild(heading);

    var tiles = document.createElement('div');
    tiles.className = 'count-row';
    tiles.append(
      tile(data.views, 'page views'),
      tile(data.visits, 'visits', grain === 'day' ? 'one browser tab, one day' : 'one browser tab, one day, added up'),
      tile(data.firstTime, 'first time here')
    );
    els.body.appendChild(tiles);

    [['pages', data.paths], ['came from', data.refs], ['language', data.langs],
     ['screen', data.screens], ['time on page', data.secs]].forEach(function (pair) {
      var block = table(pair[0], pair[1]);
      if (block) els.body.appendChild(block);
    });

    var newestKey = Array.from(days.keys()).sort().pop();
    var newest = days.get(newestKey);
    if (newest && newest.mine) {
      var own = document.createElement('p');
      own.className = 'muted-note stats-fresh';
      own.textContent = 'Counted in this browser just now, straight from the beacons.';
      els.body.appendChild(own);
    } else if (newest && newest.at) {
      var when = new Date(newest.at * 1000);
      var age = Date.now() / 1000 - newest.at;
      var freshness = document.createElement('p');
      freshness.className = 'muted-note stats-fresh';
      var stamp = when.toLocaleTimeString(document.documentElement.lang === 'pt' ? 'pt-PT' : 'en-GB',
        { hour: '2-digit', minute: '2-digit' });
      if (age > 90 * 60) {
        freshness.classList.add('stale');
        freshness.textContent = 'Last counted at ' + stamp + ' on ' +
          when.toISOString().slice(0, 10) + '. They are refreshed whenever an organizer opens this page.';
      } else {
        freshness.textContent = 'Updated at ' + stamp + '.';
      }
      els.body.appendChild(freshness);
    }

    var note = document.createElement('p');
    note.className = 'muted-note';
    note.textContent = 'Counted from ' + data.beacons + ' beacons' +
      (data.days > 1 ? ' over ' + data.days + ' days' : '') +
      (data.capped ? ', ' + data.capped + ' capped' : '') +
      (data.ungrouped ? ', ' + data.ungrouped + ' could not be grouped into a visit' : '') +
      '. Visits that end by closing the last tab are often missed, so the real number is higher. ' +
      'Anyone can send made-up beacons; the obvious ones are thrown away. Treat this as a shape, not a measurement.';
    els.body.appendChild(note);
  }

  document.addEventListener('semrede-login', function () { watch(); render(); });
  document.addEventListener('semrede-logout', render);
  mod.onChange(render);
  auth.ready.then(function () { watch(); render(); });
  mod.watch();
  if (els.dots) net.relayStatus(els.dots, null);
  watch();
  render();
})();
