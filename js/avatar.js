/* Profile picture on /login. The upload itself is js/blossom.js; here the
 * resulting URL goes into the profile (kind 0), which is what every NOSTR
 * client reads, so a picture set elsewhere shows up here unchanged.
 */
(function () {
  'use strict';

  var net = window.SemRedeNet;
  var auth = window.SemRedeNostr;

  // Tried in order; the first two that accept the file are used, so one server
  // going away does not take the picture with it.
  var blossom = window.SemRedeBlossom;

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

  // A square crop, uploaded the same way as pictures in posts.
  function run(file) {
    status('Uploading...');
    return blossom.upload(file, { square: true, side: 512 }).then(function (result) {
      return savePicture(result.url);
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
