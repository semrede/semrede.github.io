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

  // Leaving a browser key behind loses it unless it was saved. Nobody is asked
  // anything when the key was never used, and tickets are only mentioned when
  // the relays show that this key really asked for some.
  function askedForTickets() {
    var coords = (window.SemRedeConfig.EVENTS || []).map(function (e) { return e.coord; });
    return net.pool.querySync(net.RELAYS, { kinds: [31925], authors: [auth.pubkey], '#a': coords }, { maxWait: 3000 })
      .then(function (events) {
        var latest = {};
        events.forEach(function (ev) {
          var a = (ev.tags.filter(function (t) { return t[0] === 'a'; })[0] || [])[1];
          if (!latest[a] || latest[a].created_at < ev.created_at) latest[a] = ev;
        });
        return Object.keys(latest).some(function (a) {
          return latest[a].tags.some(function (t) { return t[0] === 'status' && t[1] === 'accepted'; });
        });
      }, function () { return false; });
  }

  // Resolves true when it is fine to go ahead.
  function confirmLeaving(action) {
    if (!auth.pubkey || auth.mode !== 'local' || !auth.used()) return Promise.resolve(true);
    return askedForTickets().then(function (tickets) {
      return confirm(tickets
        ? 'The key this browser holds asked for tickets, and the tickets belong to that key. Save it first (Show, above), or they are lost. ' + action
        : 'The key this browser holds has already been used here. Save it first (Show, above) if you want to keep it. ' + action);
    });
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
      var button = els.btnExtension;
      button.disabled = true;
      confirmLeaving('Use the extension instead?').then(function (ok) {
        if (!ok) return;
        return auth.loginWithExtension();
      }).catch(function (err) {
        showError(els.loginError, err.message === 'No NOSTR extension found'
          ? 'No NOSTR extension found in this browser. Install Alby or nos2x, or log in with your nsec below.'
          : 'The extension did not share a key. Unlock it and allow this site, then try again.');
      }).then(function () { button.disabled = false; });
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
      var value = els.importKey.value.trim();
      if (!/^(nsec1[0-9a-z]+|[0-9a-f]{64})$/i.test(value)) return showError(els.loginError, 'Paste a key that starts with nsec1');
      confirmLeaving('Use the key you pasted instead?').then(function (ok) {
        if (!ok) return;
        try {
          auth.importKey(value);
          els.importKey.value = '';
        } catch (err) {
          showError(els.loginError, err.message);
        }
      });
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
      confirmLeaving('Log out?').then(function (ok) { if (ok) auth.logout(); });
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
