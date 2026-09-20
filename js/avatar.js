/* Profile picture upload for /login.
 *
 * The site is static, so pictures go to public Blossom media servers (BUD-01/02):
 * the file is addressed by its sha256 and the upload is authorised with a kind
 * 24242 event signed by the visitor's own key. The resulting URL goes into the
 * profile (kind 0), which is what every NOSTR client reads.
 */
(function () {
  'use strict';

  var net = window.SemRedeNet;
  var auth = window.SemRedeNostr;

  // Tried in order; the first two that accept the file are used, so one server
  // going away does not take the picture with it.
  var SERVERS = ['https://blossom.band', 'https://blossom.primal.net', 'https://nostr.download'];
  var MAX_SIDE = 512;
  var MAX_BYTES = 300 * 1024;

  var $ = function (id) { return document.getElementById(id); };
  var els = {
    input: $('avatar-input'), button: $('avatar-button'), status: $('avatar-status'),
    preview: $('avatar-preview'), remove: $('avatar-remove')
  };
  if (!els.input) return;

  function status(msg, kind) {
    els.status.textContent = msg || '';
    els.status.className = 'avatar-status' + (kind ? ' ' + kind : '');
  }

  // Square crop, scaled down, re-encoded. Keeps uploads small and strips
  // whatever metadata the camera put in the original file.
  function prepare(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        URL.revokeObjectURL(url);
        var side = Math.min(img.naturalWidth, img.naturalHeight);
        var size = Math.min(side, MAX_SIDE);
        var canvas = document.createElement('canvas');
        canvas.width = canvas.height = size;
        var ctx = canvas.getContext('2d');
        ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, size, size);
        canvas.toBlob(function (blob) {
          if (!blob) return reject(new Error('Could not read that image'));
          if (blob.size > MAX_BYTES) return reject(new Error('That picture is too heavy even after shrinking'));
          resolve(blob);
        }, 'image/webp', 0.85);
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error('That file is not an image this browser can read'));
      };
      img.src = url;
    });
  }

  function sha256Hex(buffer) {
    return crypto.subtle.digest('SHA-256', buffer).then(function (hash) {
      return Array.from(new Uint8Array(hash)).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
    });
  }

  function authHeader(hash) {
    var now = Math.floor(Date.now() / 1000);
    return auth.signEvent({
      kind: 24242,
      created_at: now,
      tags: [['t', 'upload'], ['x', hash], ['expiration', String(now + 300)]],
      content: 'Upload a profile picture for semrede.com'
    }).then(function (ev) {
      return 'Nostr ' + btoa(unescape(encodeURIComponent(JSON.stringify(ev))));
    });
  }

  function uploadTo(server, blob, header) {
    return fetch(server + '/upload', {
      method: 'PUT',
      headers: { Authorization: header, 'Content-Type': blob.type || 'image/webp' },
      body: blob
    }).then(function (res) {
      if (!res.ok) throw new Error(server + ' said ' + res.status);
      return res.json();
    }).then(function (data) {
      if (!data || typeof data.url !== 'string' || !/^https:\/\//.test(data.url)) throw new Error('no url returned');
      return data.url;
    });
  }

  function run(file) {
    status('Preparing the picture...');
    var blob;
    return prepare(file)
      .then(function (b) {
        blob = b;
        return b.arrayBuffer();
      })
      .then(sha256Hex)
      .then(authHeader)
      .then(function (header) {
        status('Uploading...');
        // Try every server, keep the ones that worked.
        return Promise.allSettled(SERVERS.map(function (s) { return uploadTo(s, blob, header); }));
      })
      .then(function (results) {
        var urls = results.filter(function (r) { return r.status === 'fulfilled'; }).map(function (r) { return r.value; });
        if (!urls.length) throw new Error('No media server accepted the picture. Try again later.');
        return savePicture(urls[0]);
      });
  }

  // Keep the rest of the profile as it is and change only the picture.
  function savePicture(url) {
    status('Saving your profile...');
    var p = net.profiles.get(auth.pubkey);
    var data = Object.assign({}, (p && p.raw) || {});
    if (url) data.picture = url; else delete data.picture;
    return auth.signEvent({ kind: 0, created_at: Math.floor(Date.now() / 1000), tags: [], content: JSON.stringify(data) })
      .then(function (ev) {
        net.applyProfile(ev);
        return net.publish(ev);
      })
      .then(function (ok) {
        if (!ok) throw new Error('No relay accepted the profile');
        showPreview();
        status(url ? 'Picture saved.' : 'Picture removed.', 'ok');
      });
  }

  function showPreview() {
    if (!auth.pubkey) return;
    net.fillAvatar(els.preview, auth.pubkey);
    var p = net.profiles.get(auth.pubkey);
    els.remove.hidden = !(p && p.picture);
  }

  els.button.addEventListener('click', function () { els.input.click(); });

  els.input.addEventListener('change', function () {
    var file = els.input.files && els.input.files[0];
    els.input.value = '';
    if (!file) return;
    if (!/^image\//.test(file.type)) return status('Pick an image file.', 'bad');
    els.button.disabled = true;
    run(file).catch(function (err) {
      status(err.message || 'Could not set the picture', 'bad');
    }).finally(function () {
      els.button.disabled = false;
    });
  });

  els.remove.addEventListener('click', function () {
    els.remove.disabled = true;
    savePicture('').catch(function (err) {
      status(err.message || 'Could not remove the picture', 'bad');
    }).finally(function () { els.remove.disabled = false; });
  });

  document.addEventListener('semrede-login', showPreview);
  net.onProfile(function (pubkey) { if (pubkey === auth.pubkey) showPreview(); });
  auth.ready.then(showPreview);
})();
