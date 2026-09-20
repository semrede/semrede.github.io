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
    body: document.getElementById('stats-body'),
    day: document.getElementById('stats-day')
  };
  if (!els.section || !cfg || !cfg.STATS || !S) return;

  var days = new Map();     // 'YYYY-MM-DD' -> {at, data}
  var watching = false;
  var current = null;

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

    if (!current || all.indexOf(current) === -1) current = all[0];
    if (els.day) {
      els.day.textContent = '';
      all.slice(0, 30).forEach(function (day) {
        var option = document.createElement('option');
        option.value = day;
        option.textContent = day;
        if (day === current) option.selected = true;
        els.day.appendChild(option);
      });
      els.day.hidden = false;
    }

    var data = days.get(current).data;

    var tiles = document.createElement('div');
    tiles.className = 'count-row';
    tiles.append(
      tile(data.views, 'page views'),
      tile(data.visits, 'visits', 'one browser tab, one day'),
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
      (data.capped ? ', ' + data.capped + ' capped' : '') +
      (data.ungrouped ? ', ' + data.ungrouped + ' could not be grouped into a visit' : '') +
      '. Visits that end by closing the last tab are often missed, so the real number is higher. ' +
      'Anyone can send made-up beacons; the obvious ones are thrown away. Treat this as a shape, not a measurement.';
    els.body.appendChild(note);
  }

  if (els.day) els.day.addEventListener('change', function () { current = els.day.value; render(); });

  document.addEventListener('semrede-login', function () { watch(); render(); });
  document.addEventListener('semrede-logout', render);
  mod.onChange(render);
  auth.ready.then(function () { watch(); render(); });
  watch();
  render();
})();
