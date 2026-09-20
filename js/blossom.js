/* Uploading pictures to public Blossom servers (BUD-01/02).
 *
 * The site is static, so files go to media servers that take anything signed by
 * the uploader: the file is addressed by its sha256 and the upload is
 * authorised with a kind 24242 event. Only the resulting URL ends up in a post,
 * which is how pictures normally travel on NOSTR.
 */
(function () {
  'use strict';

  var auth = window.SemRedeNostr;

  var SERVERS = ['https://blossom.band', 'https://blossom.primal.net', 'https://nostr.download'];
  var MAX_SIDE = 1600;
  var MAX_BYTES = 2 * 1024 * 1024;

  function sha256Hex(buffer) {
    return crypto.subtle.digest('SHA-256', buffer).then(function (hash) {
      return Array.from(new Uint8Array(hash)).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
    });
  }

  // Scale down and re-encode, which keeps uploads small and drops the metadata
  // the camera wrote into the original file.
  function prepare(file, maxSide) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        URL.revokeObjectURL(url);
        var scale = Math.min(1, (maxSide || MAX_SIDE) / Math.max(img.naturalWidth, img.naturalHeight));
        var w = Math.round(img.naturalWidth * scale);
        var h = Math.round(img.naturalHeight * scale);
        var canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        canvas.toBlob(function (blob) {
          if (!blob) return reject(new Error('Could not read that image'));
          if (blob.size > MAX_BYTES) return reject(new Error('That picture is too heavy even after shrinking'));
          resolve({ blob: blob, width: w, height: h });
        }, 'image/webp', 0.85);
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error('That file is not an image this browser can read'));
      };
      img.src = url;
    });
  }

  function square(file, side) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        URL.revokeObjectURL(url);
        var src = Math.min(img.naturalWidth, img.naturalHeight);
        var size = Math.min(src, side);
        var canvas = document.createElement('canvas');
        canvas.width = canvas.height = size;
        canvas.getContext('2d').drawImage(img, (img.naturalWidth - src) / 2, (img.naturalHeight - src) / 2, src, src, 0, 0, size, size);
        canvas.toBlob(function (blob) {
          if (!blob) return reject(new Error('Could not read that image'));
          resolve({ blob: blob, width: size, height: size });
        }, 'image/webp', 0.85);
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('That file is not an image this browser can read')); };
      img.src = url;
    });
  }

  function authHeader(hash) {
    var now = Math.floor(Date.now() / 1000);
    return auth.signEvent({
      kind: 24242,
      created_at: now,
      tags: [['t', 'upload'], ['x', hash], ['expiration', String(now + 300)]],
      content: 'Upload a picture for semrede.com'
    }).then(function (ev) {
      return 'Nostr ' + btoa(unescape(encodeURIComponent(JSON.stringify(ev))));
    });
  }

  function putTo(server, blob, header) {
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

  // Uploads to every server and keeps the first URL that worked, so one server
  // disappearing does not take the picture with it.
  function upload(file, options) {
    var opts = options || {};
    var prep = opts.square ? square(file, opts.side || 512) : prepare(file, opts.side);
    var picture;
    return prep.then(function (result) {
      picture = result;
      return result.blob.arrayBuffer();
    }).then(sha256Hex).then(function (hash) {
      picture.hash = hash;
      return authHeader(hash);
    }).then(function (header) {
      return Promise.allSettled(SERVERS.map(function (s) { return putTo(s, picture.blob, header); }));
    }).then(function (results) {
      var urls = results.filter(function (r) { return r.status === 'fulfilled'; }).map(function (r) { return r.value; });
      if (!urls.length) throw new Error('No media server accepted the picture. Try again later.');
      return {
        url: urls[0],
        mirrors: urls,
        hash: picture.hash,
        width: picture.width,
        height: picture.height,
        // NIP-92: describes the picture that the post links to
        imeta: ['imeta', 'url ' + urls[0], 'm image/webp', 'x ' + picture.hash, 'dim ' + picture.width + 'x' + picture.height]
      };
    });
  }

  window.SemRedeBlossom = { upload: upload, servers: SERVERS };
})();
