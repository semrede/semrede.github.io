/* The login card and the "this is you" card, shared by /chat and /forum.
 * Expects the element ids used in both pages; missing elements are ignored.
 */
(function () {
  'use strict';

  var net = window.SemRedeNet;
  var auth = window.SemRedeNostr;

  var $ = function (id) { return document.getElementById(id); };
  var els = {
    loginCard: $('login-card'), loginTitle: $('login-title'), meCard: $('me-card'), loginError: $('login-error'), meError: $('me-error'),
    btnExtension: $('btn-extension'), extensionHint: $('extension-hint'),
    createForm: $('create-form'), newName: $('new-name'), importForm: $('import-form'), importKey: $('import-key'),
    meAvatar: $('me-avatar'), meName: $('me-name'), meCallsign: $('me-callsign'),
    nameForm: $('name-form'), nameInput: $('me-name-input'),
    backup: $('backup-box'), nsecValue: $('nsec-value'), nsecReveal: $('nsec-reveal'), nsecCopy: $('nsec-copy'),
    npubValue: $('npub-value'), npubCopy: $('npub-copy'), logout: $('btn-logout'),
    composer: $('composer'), locked: $('composer-locked')
  };

  var ownProfileChecked = false;
  var listeners = [];
  var MASK = 'nsec1' + '*'.repeat(12);

  function showError(el, msg) {
    if (!el) return;
    el.textContent = msg;
    clearTimeout(el._t);
    el._t = setTimeout(function () { el.textContent = ''; }, 6000);
  }

  function shortKey(s) { return s.slice(0, 10) + '...' + s.slice(-6); }

  function refresh() {
    var loggedIn = !!auth.pubkey;
    // A key kept in this browser (usually the one made on the first visit) can
    // still be swapped for an extension or an existing nsec, so the login card
    // stays, minus the "create" form.
    var swappable = loggedIn && auth.mode === 'local';
    if (els.loginCard) els.loginCard.hidden = loggedIn && !swappable;
    if (els.createForm) els.createForm.hidden = loggedIn;
    if (els.loginTitle) els.loginTitle.innerHTML = swappable ? 'Use <em>another key</em>' : 'Join the <em>room</em>';
    if (els.meCard) els.meCard.hidden = !loggedIn;
    if (els.composer) els.composer.hidden = !loggedIn;
    if (els.locked) els.locked.hidden = loggedIn;
    document.body.classList.toggle('logged-in', loggedIn);
    if (loggedIn && els.meName) {
      var p = net.profiles.get(auth.pubkey);
      els.meName.textContent = net.displayName(auth.pubkey);
      els.meCallsign.textContent = auth.callsign + (auth.mode === 'extension' ? ' / extension' : ' / this browser');
      net.fillAvatar(els.meAvatar, auth.pubkey);
      els.npubValue.textContent = shortKey(auth.npub());
      els.backup.hidden = auth.mode !== 'local';
      els.nsecValue.textContent = MASK;
      els.nsecValue.dataset.shown = '';
      els.nsecReveal.textContent = 'Show';
    }
    // /tickets has the name field without the rest of the account card.
    if (loggedIn && els.nameInput && document.activeElement !== els.nameInput) {
      var own = net.profiles.get(auth.pubkey);
      els.nameInput.value = (own && own.name) || '';
    }
    listeners.forEach(function (fn) { fn(loggedIn); });
  }

  function fetchOwnProfile() {
    return net.pool.get(net.RELAYS, { kinds: [0], authors: [auth.pubkey] }, { maxWait: 4000 }).then(function (ev) {
      if (ev) net.applyProfile(ev);
      ownProfileChecked = true;
    });
  }

  // Publish kind 0, keeping the fields an existing profile already has (picture, about, nip05...).
  function saveName(name) {
    if (!ownProfileChecked) return fetchOwnProfile().then(function () { return saveName(name); });
    var p = net.profiles.get(auth.pubkey);
    var data = Object.assign({}, (p && p.raw) || {});
    data.name = name;
    data.display_name = name;
    return auth.signEvent({ kind: 0, created_at: Math.floor(Date.now() / 1000), tags: [], content: JSON.stringify(data) })
      .then(function (ev) {
        net.applyProfile(ev);
        return net.publish(ev);
      });
  }

  // Swapping away from a browser key loses it unless it was saved, and with
  // it any ticket and private messages it holds.
  function confirmReplace() {
    if (!auth.pubkey || auth.mode !== 'local') return true;
    return confirm('This browser already has a key for you. Any ticket or messages it holds stay with it, so save it first (Show, above). Use the other key?');
  }

  function copy(text, btn) {
    navigator.clipboard.writeText(text).then(function () {
      var old = btn.textContent;
      btn.textContent = 'Copied';
      setTimeout(function () { btn.textContent = old; }, 1500);
    });
  }

  function wire() {
    if (els.btnExtension) els.btnExtension.addEventListener('click', function () {
      if (!confirmReplace()) return;
      auth.loginWithExtension().catch(function (err) {
        showError(els.loginError, err.message === 'No NOSTR extension found'
          ? 'No NOSTR extension found in this browser. Create an account instead, or install Alby or nos2x.'
          : 'The extension did not share a key.');
      });
    });

    if (els.createForm) els.createForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var name = els.newName.value.replace(/\s+/g, ' ').trim();
      if (name.length < 2) return showError(els.loginError, 'Pick a name with at least 2 characters.');
      auth.createAccount().then(function () {
        net.profiles.set(auth.pubkey, { name: name, picture: '', created_at: 0, raw: {} });
        if (window.SemRedeSession) window.SemRedeSession.saveProfile({ name: name, picture: '', at: 0 });
        ownProfileChecked = true;
        refresh();
        return saveName(name);
      });
    });

    if (els.importForm) els.importForm.addEventListener('submit', function (e) {
      e.preventDefault();
      if (!confirmReplace()) return;
      try {
        auth.importKey(els.importKey.value);
        els.importKey.value = '';
      } catch (err) {
        showError(els.loginError, err.message);
      }
    });

    if (els.nameForm) els.nameForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var name = els.nameInput.value.replace(/\s+/g, ' ').trim();
      if (name.length < 2) return showError(els.meError, 'Use at least 2 characters.');
      saveName(name).then(function () { els.nameInput.blur(); refresh(); },
        function () { showError(els.meError, 'Could not save the name.'); });
    });

    if (els.nsecReveal) els.nsecReveal.addEventListener('click', function () {
      var shown = els.nsecValue.dataset.shown === '1';
      els.nsecValue.textContent = shown ? MASK : auth.nsec();
      els.nsecValue.dataset.shown = shown ? '' : '1';
      els.nsecReveal.textContent = shown ? 'Show' : 'Hide';
    });
    if (els.nsecCopy) els.nsecCopy.addEventListener('click', function () { copy(auth.nsec(), els.nsecCopy); });
    if (els.npubCopy) els.npubCopy.addEventListener('click', function () { copy(auth.npub(), els.npubCopy); });
    if (els.logout) els.logout.addEventListener('click', function () {
      if (auth.mode === 'local' && !confirm('This account only exists in this browser. Log out only if you saved your key, or you lose it together with any ticket it holds. Log out?')) return;
      auth.logout();
    });

    document.addEventListener('semrede-login', function () {
      ownProfileChecked = false;
      net.requestProfile(auth.pubkey);
      refresh();
      fetchOwnProfile();
    });
    document.addEventListener('semrede-logout', refresh);
    net.onProfile(function (pubkey) { if (pubkey === auth.pubkey) refresh(); });
  }

  wire();
  refresh();
  auth.ready.then(function () {
    if (els.extensionHint) els.extensionHint.classList.toggle('found', auth.extensionAvailable);
    if (els.btnExtension && !auth.extensionAvailable) els.btnExtension.classList.add('muted');
  });

  window.SemRedeIdentity = {
    refresh: refresh,
    onChange: function (fn) { listeners.push(fn); fn(!!auth.pubkey); },
    showError: showError
  };
})();
