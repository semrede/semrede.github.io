/* The Haleen player on the home page.
 *
 * The track list comes from js/music-data.js (a snapshot of the Fountain feeds,
 * rebuilt with tools/music.mjs) and the audio is streamed straight from
 * Fountain, so every play counts for the artist there.
 */
(function () {
  'use strict';

  var data = window.SemRedeMusic;
  var $ = function (id) { return document.getElementById(id); };
  var els = {
    player: $('player'), play: $('player-play'), prev: $('player-prev'), next: $('player-next'),
    title: $('player-title'), album: $('player-album'), cover: $('player-cover'),
    bar: $('player-bar'), fill: $('player-fill'), time: $('player-time'),
    list: $('player-list'), toggle: $('player-toggle'), count: $('player-count')
  };
  if (!data || !els.player || !data.tracks.length) return;

  var audio = new Audio();
  audio.preload = 'none';
  var index = 0;
  var playing = false;

  function clock(seconds) {
    if (!seconds || !isFinite(seconds)) return '0:00';
    var m = Math.floor(seconds / 60);
    var s = Math.floor(seconds % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  function current() {
    return data.tracks[index];
  }

  function load(i, autoplay) {
    index = (i + data.tracks.length) % data.tracks.length;
    var track = current();
    audio.src = track.url;
    els.title.textContent = track.title;
    els.album.textContent = track.album && track.album !== track.title ? track.album : data.artist;
    if (track.cover) els.cover.src = track.cover;
    els.fill.style.width = '0%';
    els.time.textContent = '0:00 / ' + clock(track.duration);
    markList();
    if (autoplay) play();
  }

  function play() {
    audio.play().then(function () {
      playing = true;
      setPlayIcon();
    }).catch(function () {
      // autoplay refused, or the file is unreachable
      playing = false;
      setPlayIcon();
    });
  }

  function pause() {
    audio.pause();
    playing = false;
    setPlayIcon();
  }

  function setPlayIcon() {
    els.play.classList.toggle('playing', playing);
    els.play.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    els.player.classList.toggle('is-playing', playing);
  }

  function markList() {
    Array.prototype.forEach.call(els.list.children, function (row, i) {
      row.classList.toggle('current', i === index);
    });
  }

  function buildList() {
    data.tracks.forEach(function (track, i) {
      var row = document.createElement('button');
      row.type = 'button';
      row.className = 'track';
      var n = document.createElement('span');
      n.className = 'track-n';
      n.textContent = String(i + 1);
      var name = document.createElement('span');
      name.className = 'track-name';
      name.textContent = track.title;
      var len = document.createElement('span');
      len.className = 'track-len';
      len.textContent = clock(track.duration);
      row.append(n, name, len);
      row.addEventListener('click', function () { load(i, true); });
      els.list.appendChild(row);
    });
    els.count.textContent = data.tracks.length + ' tracks';
  }

  function seek(e) {
    var rect = els.bar.getBoundingClientRect();
    var ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    if (audio.duration) audio.currentTime = ratio * audio.duration;
  }

  audio.addEventListener('timeupdate', function () {
    var total = audio.duration || current().duration || 0;
    els.fill.style.width = total ? (audio.currentTime / total) * 100 + '%' : '0%';
    els.time.textContent = clock(audio.currentTime) + ' / ' + clock(total);
  });
  audio.addEventListener('ended', function () { load(index + 1, true); });
  audio.addEventListener('error', function () {
    els.title.textContent = current().title + ' (not reachable)';
    playing = false;
    setPlayIcon();
  });

  els.play.addEventListener('click', function () {
    if (!audio.src) return load(index, true);
    if (playing) pause(); else play();
  });
  els.prev.addEventListener('click', function () { load(index - 1, playing || !!audio.src); });
  els.next.addEventListener('click', function () { load(index + 1, playing || !!audio.src); });
  els.bar.addEventListener('click', seek);
  els.toggle.addEventListener('click', function () {
    var open = els.list.hidden;
    els.list.hidden = !open;
    els.toggle.textContent = open ? 'Hide the tracks' : 'All tracks';
  });

  buildList();
  load(0, false);
})();
