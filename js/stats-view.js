/* The Stats card on /admin.
 *
 * The daily numbers are published by tools/stats.mjs as NIP-78 events signed
 * by the stats key and encrypted to each moderator. Nobody else can read them,
 * and because the filter asks for that author only, nobody else can forge one
 * either.
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
    body: document.getElementById('stats-body')
  };
  if (!els.section || !cfg || !cfg.STATS || !S) return;

  var days = new Map();     // 'YYYY-MM-DD' -> {at, data}
  var watching = false;
  var current = null;       // the bucket key being shown below the chart
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
      if (known && known.at >= ev.created_at) return;
      days.set(data.day, { at: ev.created_at, data: data });
      if (!current) current = data.day;
      render();
    }, function () { /* not for this key */ });
  }

  function watch() {
    if (watching || !auth.pubkey) return;
    watching = true;
    net.pool.subscribeMany(net.RELAYS, {
      kinds: [S.RUMOR_KIND], authors: [cfg.STATS.PUBKEY], '#p': [auth.pubkey], limit: 120
    }, { onevent: apply });
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
      column.addEventListener('click', function () { current = point.key; render(); });
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
    els.body.textContent = '';

    if (!auth.pubkey || !mod.isModerator(auth.pubkey)) return;

    var all = Array.from(days.keys()).sort().reverse();
    if (!all.length) {
      var none = document.createElement('p');
      none.className = 'muted-note';
      none.textContent = 'No numbers yet. They arrive once the organizers run the daily count.';
      els.body.appendChild(none);
      return;
    }

    var points = series(grain);
    if (!current || !points.some(function (p) { return p.key === current; })) {
      current = points.length ? points[points.length - 1].key : null;
    }

    els.body.append(grainSwitch(), chart(points));

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
  watch();
  render();
})();
