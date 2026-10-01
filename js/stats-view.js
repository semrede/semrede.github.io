/* The visit numbers on /stats.
 *
 * There is nothing scheduled anywhere. The beacons are encrypted to the admin
 * key, so when an organizer opens this page their own browser reads them off
 * the relays, decrypts them, counts them, and publishes the day for the
 * moderation team. A moderator who is not the admin reads those published days
 * instead, and cannot read a single raw beacon.
 *
 * A day, a week or a month that is over is published once as a final summary
 * note, so opening the page reads a handful of summaries (decrypted once and
 * then kept in this browser) and only today's beacons, instead of every beacon
 * of the last thirty days.
 *
 * Aggregates are accepted only from the admin key, the readers, or the stats
 * key that published the first days, so nobody can forge a day.
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

  // What is known, per grain: key -> {at, data, final, mine}. A final entry is
  // a summary of a period that is over; the rest are live counts.
  var notes = { day: new Map(), week: new Map(), month: new Map() };
  var days = notes.day;
  var watching = false;
  var reading = false;      // busy loading summaries or decrypting beacons
  var status = '';          // what to say about where the numbers come from
  var PUB_KEY = 'semrede_stats_published';   // d tag -> what this browser last sent
  var NOTES_KEY = 'semrede_stats_notes';     // event id -> decrypted summary
  var current = null;       // the bucket key being shown below the chart
  var picked = false;       // true once somebody chose a bucket themselves
  var grain = 'day';        // day | week | month | year
  var notesLoaded = null;   // a promise, once the summaries have been asked for

  // A beacon arriving late (the outbox, a slow relay) still lands in its day
  // for a while after midnight, so a day is only closed an hour later.
  var GRACE = 3600;
  // Beacons are only read this far back, and that is how far a summary can be
  // rebuilt from them.
  var WINDOW_DAYS = 30;

  // A page opened by a test can hand the card a set of days, so the chart can
  // be looked at without waiting for a month of real traffic. Never set by the
  // site itself.
  if (window.SemRedeStatsFixture) {
    Object.keys(window.SemRedeStatsFixture).forEach(function (day) {
      days.set(day, { at: 0, data: window.SemRedeStatsFixture[day] });
    });
  }

  function nowSecs() { return Math.floor(Date.now() / 1000); }
  function today() { return S.dayOf(nowSecs()); }

  function periodEnd(grain, key) {
    var list = S.daysIn(grain, key);
    return Date.parse(S.addDays(list[list.length - 1], 1) + 'T00:00:00Z') / 1000;
  }

  function closed(grain, key) {
    return nowSecs() >= periodEnd(grain, key) + GRACE;
  }

  // Which of two versions of the same period to keep: a summary beats a live
  // count, then the bigger one (a smaller number means missing beacons, not
  // fewer visits), then the newer one.
  function better(a, b) {
    if (!a) return b;
    if (!b) return a;
    if (!!a.final !== !!b.final) return a.final ? a : b;
    if ((a.data.views || 0) !== (b.data.views || 0)) return a.data.views > b.data.views ? a : b;
    return b.at >= a.at ? b : a;
  }

  function accept(grain, key, entry) {
    if (!entry) return false;
    var map = notes[grain];
    var kept = better(map.get(key), entry);
    if (kept === map.get(key)) return false;
    map.set(key, kept);
    return true;
  }

  function fromNote(grain, key, at, data) {
    if (!data || typeof data !== 'object' || typeof data.views !== 'number') return null;
    return { at: at, data: data, final: data.final === true && grain === (data.grain || 'day') && key === (data.key || data.day) };
  }

  // ---- reading the summaries ----

  function noteCache() {
    try { return JSON.parse(localStorage.getItem(NOTES_KEY) || '{}') || {}; } catch (e) { return {}; }
  }

  function saveNoteCache(map) {
    // Replaced notes leave their old ids behind; keep the newest few hundred.
    var ids = Object.keys(map).sort(function (a, b) { return map[b].at - map[a].at; }).slice(0, 600);
    var out = {};
    ids.forEach(function (id) { out[id] = map[id]; });
    try { localStorage.setItem(NOTES_KEY, JSON.stringify(out)); } catch (e) { /* full or private */ }
  }

  function authors() {
    var list = [cfg.ADMIN_PUBKEY];
    if (cfg.STATS.LEGACY_PUBKEY) list.push(cfg.STATS.LEGACY_PUBKEY);
    (cfg.STATS.READERS || []).forEach(function (pk) { if (list.indexOf(pk) === -1) list.push(pk); });
    return list;
  }

  // Everything addressed to this key, all at once: what came back before the
  // relays said "that is all" is handled as a batch, so cached notes are drawn
  // straight away and old days already covered by a month are not decrypted at
  // all. Anything after that (a summary published while the page is open) is
  // handled as it comes.
  function loadNotes() {
    if (notesLoaded) return notesLoaded;
    notesLoaded = new Promise(function (resolve) {
      var batch = [];
      var live = false;
      var finished = false;
      function done() {
        if (finished) return;
        finished = true;
        live = true;
        handle(batch).then(resolve, resolve);
      }
      net.pool.subscribeMany(net.RELAYS, {
        kinds: [S.RUMOR_KIND], authors: authors(), '#p': [auth.pubkey], limit: 2000
      }, {
        onevent: function (ev) { if (live) handle([ev]); else batch.push(ev); },
        oneose: done
      });
      setTimeout(done, 8000);
    });
    return notesLoaded;
  }

  function handle(events) {
    var cache = noteCache();
    var cutoff = S.addDays(today(), -62);
    var monthsKnown = {};
    var todo = [];

    events.forEach(function (ev) {
      var parsed = S.parseSummaryD((ev.tags.filter(function (t) { return t[0] === 'd'; })[0] || [])[1]);
      if (parsed) { ev._sum = parsed; if (parsed.grain === 'month') monthsKnown[parsed.key] = 1; }
    });

    var changed = false;
    events.forEach(function (ev) {
      var s = ev._sum;
      if (!s) return;
      var hit = cache[ev.id];
      if (hit) {
        changed = accept(s.grain, s.key, fromNote(s.grain, s.key, hit.at, hit.data) || null) || changed;
        return;
      }
      // An old day inside a month that has its own summary is never shown on
      // its own, so it is not worth a decrypt.
      if (s.grain === 'day' && s.key < cutoff && monthsKnown[s.key.slice(0, 7)]) return;
      todo.push(ev);
    });
    if (changed) render();
    if (!todo.length) return Promise.resolve();

    // Newest first, so the bars on the right fill in before the old ones.
    todo.sort(function (a, b) { return b._sum.key < a._sum.key ? -1 : 1; });
    var i = 0;
    function step() {
      var chunk = todo.slice(i, i + CHUNK);
      if (!chunk.length) { saveNoteCache(cache); render(); return Promise.resolve(); }
      if (todo.length > CHUNK) {
        status = 'Reading ' + (i + chunk.length) + ' of ' + todo.length + ' summaries...';
        render();
      }
      return Promise.all(chunk.map(function (ev) {
        return auth.decryptFrom(ev.pubkey, ev.content).then(function (json) {
          var data;
          try { data = JSON.parse(json); } catch (e) { return; }
          var entry = fromNote(ev._sum.grain, ev._sum.key, ev.created_at, data);
          if (!entry) return;
          cache[ev.id] = { at: ev.created_at, data: data };
          accept(ev._sum.grain, ev._sum.key, entry);
        }, function () { /* not for this key */ });
      })).then(function () {
        i += chunk.length;
        render();
        return step();
      });
    }
    return step().then(function () { if (!reading) status = ''; render(); });
  }

  function watch() {
    if (watching || !auth.pubkey) return;
    watching = true;
    reading = true;
    status = 'Loading the summaries...';
    render();
    loadNotes().then(function () {
      reading = false;
      status = '';
      render();
      if (canCount()) readBeacons();
    });
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
    var cutoff = nowSecs() - 45 * 86400;
    var out = {};
    Object.keys(map).forEach(function (id) { if (map[id].at > cutoff) out[id] = map[id]; });
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(out)); } catch (e) { /* full or private */ }
    return out;
  }

  // The first day anything was ever counted. Days before it are not missing,
  // they are before the site counted at all.
  function firstDay() {
    var keys = Array.from(days.keys()).filter(function (d) { return days.get(d).data.views > 0; }).sort();
    return keys[0] || null;
  }

  // Where the beacons have to be read from: the oldest day in the window that
  // has no summary yet. Normally that is today.
  function readFrom() {
    var start = S.addDays(today(), -(WINDOW_DAYS - 1));
    var first = firstDay();
    if (first && first > start) start = first;
    for (var d = start; d < today(); d = S.addDays(d, 1)) {
      var known = days.get(d);
      if (!known || !known.final) return d;
    }
    return today();
  }

  // Counts every cached beacon from `from` on. Days before it already have a
  // summary, and the cache may hold only part of them.
  function countFromCache(map, from) {
    var byDay = {};
    Object.keys(map).forEach(function (id) {
      var row = map[id];
      var day = S.dayOf(row.at);
      if (day < from) return;
      (byDay[day] = byDay[day] || []).push({ id: id, at: row.at, p: row.p });
    });
    var stamp = nowSecs();
    Object.keys(byDay).forEach(function (day) {
      accept('day', day, { at: stamp, data: S.aggregate(day, byDay[day]), mine: true });
    });
    return byDay;
  }

  // Whoever is listed as a reader of the beacons can do the counting here.
  function canCount() {
    var readers = cfg.STATS.READERS || [cfg.STATS.PUBKEY];
    return !!auth.pubkey && readers.indexOf(auth.pubkey) !== -1;
  }

  function readBeacons() {
    if (reading || !canCount()) return;
    reading = true;
    var from = readFrom();
    status = from === today() ? 'Looking for today\'s beacons...' : 'Looking for beacons since ' + from + '...';
    render();

    var since = Date.parse(from + 'T00:00:00Z') / 1000;
    // Ask every relay, not only the two the beacons are sent to: a relay that
    // will not answer must not be able to hide a day.
    var relays = (cfg.STATS.RELAYS || []).concat(net.RELAYS).filter(function (url, i, all) {
      return all.indexOf(url) === i;
    });
    pool().querySync(relays, {
      kinds: [S.RUMOR_KIND], '#p': [auth.pubkey], '#d': [S.BEACON_D], since: since, limit: 5000
    }, { maxWait: 9000 }).then(function (events) {
      var known = cache();
      var all = events.filter(function (ev) {
        return ev.kind === S.RUMOR_KIND && !known[ev.id] && ev.content.length <= S.MAX_BYTES * 3;
      }).sort(function (a, b) { return b.created_at - a.created_at; });
      var fresh = all.slice(0, MAX_PER_VISIT);
      // Only a read that got everything may close a day: a summary is final.
      var complete = events.length < 5000 && fresh.length === all.length;

      function finish() {
        known = saveCache(known);
        var counted = countFromCache(known, from);
        reading = false;
        status = complete ? '' : 'There were too many beacons for one visit. Open the page again to read the rest.';
        if (complete) summarize(from, counted);
        render();
        publishLive();
      }

      if (!fresh.length) return finish();

      var done = 0;
      function step() {
        var batch = fresh.slice(done, done + CHUNK);
        if (!batch.length) return finish();
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

  // ---- publishing ----

  function publishedLog() {
    try { return JSON.parse(localStorage.getItem(PUB_KEY) || '{}') || {}; } catch (e) { return {}; }
  }

  // The moderators, who cannot read a raw beacon, and the readers, who would
  // otherwise have to count every closed day again on their own.
  function recipients() {
    var list = mod.moderators();
    (cfg.STATS.READERS || []).forEach(function (pk) { if (list.indexOf(pk) === -1) list.push(pk); });
    return list;
  }

  // A live count is resent at most every ten minutes, so opening the page
  // repeatedly does not republish the same numbers to everybody. A summary
  // goes out once, and again only if it changed.
  function send(grain, key, data, throttle) {
    var to = recipients();
    var log = publishedLog();
    var id = grain + ':' + key;
    var fingerprint = (data.final ? 'final:' : '') + data.views + ':' + data.visits + ':' + to.length;
    var last = log[id];
    if (last && last.fingerprint === fingerprint && (!throttle || Date.now() - last.at < throttle)) return;
    log[id] = { fingerprint: fingerprint, at: Date.now() };
    try { localStorage.setItem(PUB_KEY, JSON.stringify(log)); } catch (e) { /* private mode */ }
    var title = grain === 'day' ? 'SemRede visits ' + key : 'SemRede visits, ' + grain + ' ' + key;
    to.forEach(function (pk) {
      auth.encryptFor(pk, JSON.stringify(data)).then(function (content) {
        var tags = [['d', S.summaryD(grain, key, pk)], ['p', pk], ['title', title]];
        if (data.final) tags.push(['t', S.SUM_TAG]);
        return auth.signEvent({ kind: S.RUMOR_KIND, created_at: nowSecs(), tags: tags, content: content });
      }).then(function (ev) { return net.publish(ev); }).catch(function () { /* said on the page */ });
    });
  }

  // Today, and any day not closed yet, as a live count.
  function publishLive() {
    if (!canCount()) return;
    Array.from(days.keys()).sort().slice(-3).forEach(function (day) {
      var entry = days.get(day);
      if (entry && entry.data && !entry.final) send('day', day, entry.data, 10 * 60 * 1000);
    });
  }

  // Every beacon from `from` on has just been read, so each day since then that
  // is over can be closed, empty or not, and then every week and month whose
  // days are all closed.
  function summarize(from, counted) {
    var first = firstDay();
    if (!first) return;
    for (var d = from > first ? from : first; d < today(); d = S.addDays(d, 1)) {
      if (!closed('day', d)) break;
      var entry = days.get(d);
      if (entry && entry.final && !entry.mine) continue;
      var data = Object.assign({}, entry ? entry.data : S.aggregate(d, []),
        { day: d, grain: 'day', key: d, final: true });
      days.set(d, { at: nowSecs(), data: data, final: true, mine: true });
      send('day', d, data);
    }

    // Only periods that ended recently: older ones were closed back then, or
    // their days are past the window and cannot be checked any more.
    var oldest = S.addDays(today(), -45);
    ['week', 'month'].forEach(function (g) {
      var keys = {};
      days.forEach(function (entry, day) {
        if (day >= oldest) keys[g === 'week' ? S.mondayOf(day) : day.slice(0, 7)] = 1;
      });
      Object.keys(keys).forEach(function (key) {
        if (!closed(g, key)) return;
        var list = [];
        var whole = S.daysIn(g, key).every(function (day) {
          var e = days.get(day);
          if (e && e.final) { list.push(e.data); return true; }
          return day < first;
        });
        if (!whole || !list.length) return;
        var data = Object.assign(S.merge(list), { grain: g, key: key, final: true });
        var known = notes[g].get(key);
        if (known && known.final && known.data.views === data.views && known.data.visits === data.visits) return;
        notes[g].set(key, { at: nowSecs(), data: data, final: true, mine: true });
        send(g, key, data);
      });
    });
  }

  // ---- putting days into buckets ----

  function bucketOf(day, how) {
    if (how === 'week') return S.mondayOf(day);
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

  // A week or a month with a summary is read from it; one without (the current
  // one, say) is added up from its days.
  function buckets(how) {
    var out = new Map();
    if (how === 'day') {
      days.forEach(function (entry, day) { out.set(day, entry.data); });
      return out;
    }
    if (how === 'year') {
      var byYear = {};
      buckets('month').forEach(function (data, month) {
        (byYear[month.slice(0, 4)] = byYear[month.slice(0, 4)] || []).push(data);
      });
      Object.keys(byYear).forEach(function (year) { out.set(year, S.merge(byYear[year])); });
      return out;
    }
    var loose = {};
    days.forEach(function (entry, day) {
      var key = bucketOf(day, how);
      (loose[key] = loose[key] || []).push(entry.data);
    });
    notes[how].forEach(function (entry, key) { if (entry.final) out.set(key, entry.data); });
    Object.keys(loose).forEach(function (key) { if (!out.has(key)) out.set(key, S.merge(loose[key])); });
    return out;
  }

  function series(how) {
    var map = buckets(how);
    var limit = how === 'day' ? 30 : how === 'week' ? 26 : how === 'month' ? 24 : 12;
    return Array.from(map.keys()).sort().slice(-limit).map(function (key) {
      return { key: key, data: map.get(key) };
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

      // Each bar is its own little column: the number sits on the bar's top
      // edge, so it is read with the bar and not with the one next to it.
      var bars = document.createElement('span');
      bars.className = 'chart-bars';

      function bar(kind, value) {
        var stack = document.createElement('span');
        stack.className = 'bar ' + kind;
        var number = document.createElement('i');
        number.className = 'bar-value';
        number.textContent = value;
        var fill = document.createElement('i');
        fill.className = 'bar-fill';
        fill.style.height = Math.max(2, Math.round(value / most * 100)) + '%';
        stack.append(number, fill);
        return stack;
      }

      bars.append(bar('views', point.data.views), bar('visits', point.data.visits));

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
    box.textContent = text + ' ';
    var link = document.createElement('a');
    link.href = '/login?next=/stats';
    link.textContent = 'Go to the login page';
    box.appendChild(link);
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

    var shown = points.filter(function (p) { return p.key === current; })[0];
    if (!shown) return;
    var data = shown.data;

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
