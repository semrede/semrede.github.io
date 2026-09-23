/* SemRede NOSTR identity.
 * Ported from geogram (lib/util/nostr_login_scripts.dart): extension detection,
 * in-browser keypair with a NIP-07 polyfill, callsign derivation.
 * Added: nsec import, logout, backup helpers.
 *
 * A stored session is restored synchronously, at load: api.pubkey is set before
 * anything is painted, so a returning visitor is never shown as logged out
 * while an extension is being looked for. The signer (the thing that can
 * actually sign and decrypt) is separate and may arrive later, which is what
 * api.signerReady is for; the crypto calls below wait for it themselves.
 *
 * localStorage keys:
 *   semrede_nostr_pubkey   hex pubkey (extension and local identities)
 *   semrede_nostr_privkey  hex secret key (local identities only)
 *   semrede_nostr_mode     "extension" | "local"
 *   semrede_nostr_auto     "1" while the local key is the one made on the
 *                          first visit and nobody chose another
 *
 * A visitor without a session gets a key at once, silently: nothing is
 * published until they act, so the chat, the forum and the tickets work
 * without a login step. /login still offers an extension or an nsec instead.
 */
(function () {
  'use strict';

  var NT = window.NostrTools;
  var S = window.SemRedeSession;
  if (!S) {
    console.error('js/session.js must be loaded before js/nostr-login.js');
    return;
  }
  var K_PUB = 'semrede_nostr_pubkey';
  var K_PRIV = 'semrede_nostr_privkey';
  var K_MODE = 'semrede_nostr_mode';
  var K_AUTO = 'semrede_nostr_auto';

  function store(key, value) {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch (e) { /* private mode: identity lasts for this page only */ }
  }

  function load(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }

  function bytesToHex(bytes) {
    return Array.from(bytes).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  }

  function hexToBytes(hex) {
    var bytes = new Uint8Array(hex.length / 2);
    for (var i = 0; i < hex.length; i += 2) bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
    return bytes;
  }

  // Short, stable handle shown next to names, e.g. X1QZ7K (same scheme as
  // geogram). It lives in js/session.js, which every page loads.
  var deriveCallsign = S.deriveCallsign;

  function hasExtension() {
    return !!(window.nostr && !window.nostr._semredePolyfill);
  }

  // Poll for a NIP-07 extension; they inject window.nostr shortly after load.
  function detectExtension(attempts, callback) {
    if (hasExtension()) return callback(true);
    if (attempts <= 0) return callback(false);
    setTimeout(function () { detectExtension(attempts - 1, callback); }, 200);
  }

  // NIP-07 compatible signer backed by a local key. The site signs through the
  // handle we keep here, never through window.nostr: an extension that injects
  // itself late would otherwise take over and sign with a different key.
  function makeLocalSigner(pubkeyHex, privkeyHex) {
    var sk = hexToBytes(privkeyHex);
    return {
      _semredePolyfill: true,
      getPublicKey: function () { return Promise.resolve(pubkeyHex); },
      nip44: {
        encrypt: function (peer, plaintext) {
          return Promise.resolve(NT.nip44.encrypt(plaintext, NT.nip44.getConversationKey(sk, peer)));
        },
        decrypt: function (peer, ciphertext) {
          return Promise.resolve(NT.nip44.decrypt(ciphertext, NT.nip44.getConversationKey(sk, peer)));
        }
      },
      signEvent: function (event) {
        var template = {
          kind: event.kind,
          created_at: event.created_at || Math.floor(Date.now() / 1000),
          tags: Array.isArray(event.tags) ? event.tags : [],
          content: event.content || ''
        };
        return Promise.resolve(NT.finalizeEvent(template, sk));
      }
    };
  }

  function installLocalSigner(pubkeyHex, privkeyHex) {
    signer = makeLocalSigner(pubkeyHex, privkeyHex);
    window.nostr = signer;          // kept for other NOSTR code in the page
    setSigner(signer);
    return signer;
  }

  var extensionSigner = null;
  var signer = null;
  var resolveSigner, rejectSigner;

  // Resolves once something can sign; rejected when an extension we were told
  // to use never answers. It never leaks an unhandled rejection.
  var signerReady = new Promise(function (resolve, reject) {
    resolveSigner = resolve;
    rejectSigner = reject;
  });
  signerReady.catch(function () { /* handled at the call sites */ });

  function setSigner(next) {
    signer = next;
    api.signerState = 'ready';
    resolveSigner(next);
    // A login after a logout gets a fresh promise: the resolver above belongs
    // to the one created when the page loaded.
    api.signerReady = signerReady = Promise.resolve(next);
    document.dispatchEvent(new CustomEvent('semrede-signer', { detail: { state: 'ready' } }));
  }

  function loseSigner(message) {
    api.signerState = 'lost';
    S.setState('stale');
    rejectSigner(new Error(message));
    api.signerReady = signerReady;
    document.dispatchEvent(new CustomEvent('semrede-signer', { detail: { state: 'lost' } }));
  }

  var api = window.SemRedeNostr = {
    pubkey: null,
    callsign: null,
    mode: null,
    // True while the key is the one made automatically on the first visit.
    auto: false,
    extensionAvailable: false,

    npub: function () { return api.pubkey ? NT.nip19.npubEncode(api.pubkey) : null; },

    // Only for local identities: the key the user must back up.
    nsec: function () {
      var priv = load(K_PRIV);
      return priv ? NT.nip19.nsecEncode(hexToBytes(priv)) : null;
    },

    // "none" before a login, "pending" while an extension is being waited for,
    // then "ready", or "lost" when the extension never answered.
    signerState: 'none',
    signerReady: null,

    signEvent: function (template) {
      if (!api.pubkey) return Promise.reject(new Error('Not logged in'));
      return api.signerReady.then(function (s) { return s.signEvent(template); });
    },

    // NIP-44 is needed for private messages. Local keys always have it; an
    // extension may not, and then the messages page says so. While we are still
    // waiting for the extension we give it the benefit of the doubt, so the
    // page does not flash a warning on every load.
    canEncrypt: function () {
      if (api.signerState === 'pending') return true;
      return !!(signer && signer.nip44 && signer.nip44.encrypt);
    },

    encryptFor: function (peerPubkey, plaintext) {
      if (!api.pubkey) return Promise.reject(new Error('Not logged in'));
      return api.signerReady.then(function (s) {
        if (!s.nip44 || !s.nip44.encrypt) throw new Error('This login cannot encrypt messages');
        return s.nip44.encrypt(peerPubkey, plaintext);
      });
    },

    decryptFrom: function (peerPubkey, ciphertext) {
      if (!api.pubkey) return Promise.reject(new Error('Not logged in'));
      return api.signerReady.then(function (s) {
        if (!s.nip44 || !s.nip44.decrypt) throw new Error('This login cannot read encrypted messages');
        return s.nip44.decrypt(peerPubkey, ciphertext);
      });
    },

    loginWithExtension: function () {
      if (!hasExtension()) return Promise.reject(new Error('No NOSTR extension found'));
      extensionSigner = window.nostr;
      return window.nostr.getPublicKey().then(function (pubkey) {
        store(K_PRIV, null);
        setAuto(false);
        setSigner(extensionSigner);
        finish(pubkey, 'extension');
        return pubkey;
      });
    },

    createAccount: function () {
      var sk = NT.generateSecretKey();
      setAuto(false);
      return useLocalKey(bytesToHex(sk));
    },

    importKey: function (input) {
      var value = String(input || '').trim();
      var hex;
      if (/^nsec1/i.test(value)) {
        var decoded = NT.nip19.decode(value.toLowerCase());
        if (decoded.type !== 'nsec') throw new Error('Not an nsec key');
        hex = bytesToHex(decoded.data);
      } else if (/^[0-9a-f]{64}$/i.test(value)) {
        hex = value.toLowerCase();
      } else {
        throw new Error('Paste a key that starts with nsec1');
      }
      setAuto(false);
      return useLocalKey(hex);
    },

    logout: function () {
      store(K_PUB, null);
      store(K_PRIV, null);
      store(K_MODE, null);
      setAuto(false);
      if (window.nostr && window.nostr._semredePolyfill) {
        window.nostr = extensionSigner || undefined;
      }
      signer = null;
      api.signerState = 'none';
      api.signerReady = signerReady = rejectedSigner('Not logged in');
      api.pubkey = api.callsign = api.mode = null;
      document.dispatchEvent(new CustomEvent('semrede-logout'));
    },

    deriveCallsign: deriveCallsign
  };

  function setAuto(yes) {
    api.auto = yes;
    store(K_AUTO, yes ? '1' : null);
  }

  function useLocalKey(privHex) {
    var pubkey = NT.getPublicKey(hexToBytes(privHex));
    store(K_PRIV, privHex);
    installLocalSigner(pubkey, privHex);
    finish(pubkey, 'local');
    return Promise.resolve(pubkey);
  }

  function finish(pubkey, mode) {
    api.pubkey = pubkey;
    api.callsign = deriveCallsign(pubkey);
    api.mode = mode;
    store(K_PUB, pubkey);
    store(K_MODE, mode);
    S.save(pubkey, mode);
    document.dispatchEvent(new CustomEvent('semrede-login', { detail: { pubkey: pubkey, mode: mode } }));
  }

  function rejectedSigner(message) {
    var p = Promise.reject(new Error(message));
    p.catch(function () { /* handled at the call sites */ });
    return p;
  }

  // ---- restore a previous session ----
  //
  // Synchronous part: who is logged in. This must not wait for anything, or the
  // header shows the logged-out state on every navigation.
  var storedPriv = load(K_PRIV);
  var storedPub = load(K_PUB);
  var storedMode = load(K_MODE);

  api.signerReady = signerReady;

  if (storedPriv && /^[0-9a-f]{64}$/.test(storedPriv)) {
    var localPub = NT.getPublicKey(hexToBytes(storedPriv));
    api.pubkey = localPub;
    api.callsign = deriveCallsign(localPub);
    api.mode = 'local';
    store(K_PUB, localPub);
    store(K_MODE, 'local');
    S.save(localPub, 'local');
    installLocalSigner(localPub, storedPriv);
  } else if (storedMode === 'extension' && storedPub && /^[0-9a-f]{64}$/.test(storedPub)) {
    api.pubkey = storedPub;
    api.callsign = deriveCallsign(storedPub);
    api.mode = 'extension';
    api.signerState = 'pending';
    S.save(storedPub, 'extension');
  } else {
    // First visit (or after a logout): make a key right away. Nothing leaves
    // the browser until the visitor posts, answers or writes to someone.
    var freshPriv = bytesToHex(NT.generateSecretKey());
    var freshPub = NT.getPublicKey(hexToBytes(freshPriv));
    store(K_PRIV, freshPriv);
    setAuto(true);
    api.pubkey = freshPub;
    api.callsign = deriveCallsign(freshPub);
    api.mode = 'local';
    store(K_PUB, freshPub);
    store(K_MODE, 'local');
    S.save(freshPub, 'local');
    installLocalSigner(freshPub, freshPriv);
  }
  if (storedPriv) api.auto = load(K_AUTO) === '1';

  // Asynchronous part: find the signer. For a local key this only notes whether
  // an extension is around (for the login page) and makes sure a late extension
  // has not taken over window.nostr. For an extension session it waits for the
  // extension and checks it is still the same account.
  api.ready = new Promise(function (resolve) {
    if (api.mode === 'local') {
      detectExtension(3, function (found) {
        api.extensionAvailable = found;
        if (found) extensionSigner = window.nostr;
        window.nostr = signer;
        resolve(api.pubkey);
      });
      return;
    }

    if (api.mode === 'extension') {
      detectExtension(10, function (found) {
        api.extensionAvailable = found;
        if (!found) {
          loseSigner('Your NOSTR extension is not answering. Unlock it, or log in again.');
          return resolve(api.pubkey);
        }
        extensionSigner = window.nostr;
        window.nostr.getPublicKey().then(function (pubkey) {
          if (pubkey === api.pubkey) {
            setSigner(extensionSigner);
          } else {
            // The extension switched account behind our back.
            api.logout();
            api.loginWithExtension().catch(function () {});
          }
          resolve(api.pubkey);
        }, function () {
          loseSigner('Your NOSTR extension did not unlock. Unlock it, or log in again.');
          resolve(api.pubkey);
        });
      });
      return;
    }

    detectExtension(10, function (found) {
      api.extensionAvailable = found;
      resolve(null);
    });
  });
})();
