/* Who is logged in, read straight from this browser.
 *
 * Loaded first on every page, before anything is painted, and it depends on
 * nothing: no NOSTR bundle, no relays. It answers two questions immediately,
 * which is what stops the header from flashing "Log in" on every navigation:
 *
 *   - is somebody logged in here? -> <html data-account="in|out|stale">
 *   - what does their avatar look like? -> the --acct-color and --acct-initials
 *     custom properties, so the circle is drawn correctly by CSS alone.
 *
 * localStorage keys (the first three are written by js/nostr-login.js):
 *   semrede_nostr_pubkey   hex pubkey
 *   semrede_nostr_privkey  hex secret key, local identities only
 *   semrede_nostr_mode     "extension" | "local"
 *   semrede_profile        {pk, name, picture, at}, this visitor's own kind 0
 *
 * Everything here treats storage as untrusted: it can be missing (private
 * mode), stale, or edited by hand.
 */
(function () {
  'use strict';

  var K_PUB = 'semrede_nostr_pubkey';
  var K_PRIV = 'semrede_nostr_privkey';
  var K_MODE = 'semrede_nostr_mode';
  var K_PROFILE = 'semrede_profile';
  var K_MOD = 'semrede_mod';

  var BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  var PALETTE = ['var(--orange)', 'var(--yellow)', 'var(--teal)', 'var(--green)'];

  function read(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }

  function write(key, value) {
    try { localStorage.setItem(key, value); return true; } catch (e) { return false; }
  }

  function drop(key) {
    try { localStorage.removeItem(key); } catch (e) { /* private mode */ }
  }

  // Short, stable handle, e.g. X1QZ7K. Same scheme as geogram, and the only
  // copy: js/nostr-login.js takes it from here.
  function deriveCallsign(hexPubkey) {
    if (!hexPubkey) return '';
    var bytes = [];
    for (var i = 0; i < 6 && i < hexPubkey.length; i += 2) bytes.push(parseInt(hexPubkey.substr(i, 2), 16));
    var acc = 0, bits = 0, groups = [];
    for (var j = 0; j < bytes.length; j++) {
      acc = (acc << 8) | bytes[j];
      bits += 8;
      while (bits >= 5) {
        bits -= 5;
        groups.push((acc >> bits) & 31);
      }
    }
    return 'X1' + groups.slice(0, 4).map(function (v) { return BECH32_CHARSET[v]; }).join('').toUpperCase();
  }

  function colorFor(pubkey) {
    if (!pubkey) return PALETTE[2];
    return PALETTE[parseInt(pubkey.slice(-2), 16) % PALETTE.length];
  }

  // Two letters for the circle when there is no picture. Only letters and
  // digits survive, because this ends up inside a CSS string.
  function initialsFrom(name, callsign) {
    var source = String(name || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!source) source = String(callsign || '').toUpperCase().replace(/^X1/, '').replace(/[^A-Z0-9]/g, '');
    return source.slice(0, 2);
  }

  var pubkey = read(K_PUB);
  if (pubkey && !/^[0-9a-f]{64}$/i.test(pubkey)) pubkey = null;
  var mode = read(K_MODE);
  var callsign = pubkey ? deriveCallsign(pubkey) : null;
  var profile = null;

  function readProfile() {
    if (!pubkey) return null;
    var raw = read(K_PROFILE);
    if (!raw) return null;
    var data;
    try { data = JSON.parse(raw); } catch (e) { return null; }
    if (!data || data.pk !== pubkey) return null;
    return {
      name: String(data.name || '').slice(0, 40),
      picture: typeof data.picture === 'string' && /^https:\/\//.test(data.picture) ? data.picture : '',
      at: Number(data.at) || 0
    };
  }

  function paint(state) {
    var root = document.documentElement;
    root.dataset.account = state;
    // Only a hint for the header link; the real gate is that the moderation
    // list is signed by the admin key and the numbers are encrypted.
    if (state !== 'out' && read(K_MOD) === '1') root.dataset.mod = '1';
    else root.removeAttribute('data-mod');
    if (state === 'out') {
      root.style.removeProperty('--acct-color');
      root.style.removeProperty('--acct-initials');
      return;
    }
    root.style.setProperty('--acct-color', colorFor(pubkey));
    root.style.setProperty('--acct-initials', '"' + initialsFrom(profile && profile.name, callsign) + '"');
  }

  var api = window.SemRedeSession = {
    available: write(K_PROFILE + '_probe', '1'),

    pubkey: pubkey,
    mode: mode,
    callsign: callsign,

    profile: function () { return profile; },
    deriveCallsign: deriveCallsign,
    colorFor: colorFor,
    initialsFrom: initialsFrom,

    // Called by js/nostr-login.js when a session starts or is restored.
    save: function (nextPubkey, nextMode) {
      if (nextPubkey !== api.pubkey) {
        drop(K_PROFILE);
        profile = null;
      }
      pubkey = api.pubkey = nextPubkey;
      mode = api.mode = nextMode;
      callsign = api.callsign = deriveCallsign(nextPubkey);
      profile = profile || readProfile();
      paint('in');
    },

    // Called when a kind 0 for this visitor arrives, so the next page can draw
    // the avatar without waiting for a relay.
    saveProfile: function (data) {
      if (!pubkey || !data) return;
      var next = {
        pk: pubkey,
        name: String(data.name || '').slice(0, 40),
        picture: typeof data.picture === 'string' && /^https:\/\//.test(data.picture) ? data.picture : '',
        at: Number(data.at) || 0
      };
      if (profile && profile.at > next.at && next.at) return;
      profile = { name: next.name, picture: next.picture, at: next.at };
      if (!next.name && !next.picture) drop(K_PROFILE);
      else write(K_PROFILE, JSON.stringify(next));
      paint(document.documentElement.dataset.account === 'stale' ? 'stale' : 'in');
      document.dispatchEvent(new CustomEvent('semrede-profile'));
    },

    // "stale" means: we know who you are, but the signer is not answering.
    setState: function (state) { paint(state); },

    isModerator: function () { return read(K_MOD) === '1'; },

    // js/moderation.js calls this once the admin's list has been read, so the
    // pages that never load the relays still know whether to show the link.
    setModerator: function (yes) {
      if (yes) write(K_MOD, '1'); else drop(K_MOD);
      paint(document.documentElement.dataset.account || 'out');
    },

    clear: function () {
      drop(K_PUB);
      drop(K_PRIV);
      drop(K_MODE);
      drop(K_PROFILE);
      drop(K_MOD);
      pubkey = api.pubkey = null;
      mode = api.mode = null;
      callsign = api.callsign = null;
      profile = null;
      paint('out');
    }
  };

  drop(K_PROFILE + '_probe');
  profile = readProfile();
  paint(pubkey ? 'in' : 'out');
  document.addEventListener('semrede-logout', function () { api.clear(); });
})();
