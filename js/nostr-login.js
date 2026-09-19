/* SemRede NOSTR identity.
 * Ported from geogram (lib/util/nostr_login_scripts.dart): extension detection,
 * in-browser keypair with a NIP-07 polyfill, callsign derivation.
 * Added: nsec import, logout, backup helpers.
 *
 * localStorage keys:
 *   semrede_nostr_pubkey   hex pubkey (extension and local identities)
 *   semrede_nostr_privkey  hex secret key (local identities only)
 *   semrede_nostr_mode     "extension" | "local"
 */
(function () {
  'use strict';

  var NT = window.NostrTools;
  var BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  var K_PUB = 'semrede_nostr_pubkey';
  var K_PRIV = 'semrede_nostr_privkey';
  var K_MODE = 'semrede_nostr_mode';

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

  // Short, stable handle shown next to names, e.g. X1QZ7K (same scheme as geogram).
  function deriveCallsign(hexPubkey) {
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

  function hasExtension() {
    return !!(window.nostr && !window.nostr._semredePolyfill);
  }

  // Poll for a NIP-07 extension; they inject window.nostr shortly after load.
  function detectExtension(attempts, callback) {
    if (hasExtension()) return callback(true);
    if (attempts <= 0) return callback(false);
    setTimeout(function () { detectExtension(attempts - 1, callback); }, 200);
  }

  // NIP-07 compatible signer backed by a local key, so the rest of the site always
  // goes through window.nostr, whether the key lives in an extension or here.
  function installPolyfill(pubkeyHex, privkeyHex) {
    var sk = hexToBytes(privkeyHex);
    window.nostr = {
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

  var extensionSigner = null;

  var api = window.SemRedeNostr = {
    pubkey: null,
    callsign: null,
    mode: null,
    extensionAvailable: false,

    npub: function () { return api.pubkey ? NT.nip19.npubEncode(api.pubkey) : null; },

    // Only for local identities: the key the user must back up.
    nsec: function () {
      var priv = load(K_PRIV);
      return priv ? NT.nip19.nsecEncode(hexToBytes(priv)) : null;
    },

    signEvent: function (template) {
      if (!api.pubkey || !window.nostr) return Promise.reject(new Error('Not logged in'));
      return window.nostr.signEvent(template);
    },

    // NIP-44 is needed for private messages. Local keys always have it; an
    // extension may not, and then the messages page says so.
    canEncrypt: function () {
      return !!(window.nostr && window.nostr.nip44 && window.nostr.nip44.encrypt);
    },

    encryptFor: function (peerPubkey, plaintext) {
      if (!api.canEncrypt()) return Promise.reject(new Error('This login cannot encrypt messages'));
      return Promise.resolve(window.nostr.nip44.encrypt(peerPubkey, plaintext));
    },

    decryptFrom: function (peerPubkey, ciphertext) {
      if (!api.canEncrypt()) return Promise.reject(new Error('This login cannot read encrypted messages'));
      return Promise.resolve(window.nostr.nip44.decrypt(peerPubkey, ciphertext));
    },

    loginWithExtension: function () {
      if (!hasExtension()) return Promise.reject(new Error('No NOSTR extension found'));
      extensionSigner = window.nostr;
      return window.nostr.getPublicKey().then(function (pubkey) {
        store(K_PRIV, null);
        finish(pubkey, 'extension');
        return pubkey;
      });
    },

    createAccount: function () {
      var sk = NT.generateSecretKey();
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
      return useLocalKey(hex);
    },

    logout: function () {
      store(K_PUB, null);
      store(K_PRIV, null);
      store(K_MODE, null);
      if (window.nostr && window.nostr._semredePolyfill) {
        window.nostr = extensionSigner || undefined;
      }
      api.pubkey = api.callsign = api.mode = null;
      document.dispatchEvent(new CustomEvent('semrede-logout'));
    },

    deriveCallsign: deriveCallsign
  };

  function useLocalKey(privHex) {
    var pubkey = NT.getPublicKey(hexToBytes(privHex));
    store(K_PRIV, privHex);
    installPolyfill(pubkey, privHex);
    finish(pubkey, 'local');
    return Promise.resolve(pubkey);
  }

  function finish(pubkey, mode) {
    api.pubkey = pubkey;
    api.callsign = deriveCallsign(pubkey);
    api.mode = mode;
    store(K_PUB, pubkey);
    store(K_MODE, mode);
    document.dispatchEvent(new CustomEvent('semrede-login', { detail: { pubkey: pubkey, mode: mode } }));
  }

  // Restore a previous session: local keys immediately, extension once it has injected itself.
  api.ready = new Promise(function (resolve) {
    var priv = load(K_PRIV);
    var mode = load(K_MODE);
    if (priv && /^[0-9a-f]{64}$/.test(priv)) {
      detectExtension(3, function (found) {
        api.extensionAvailable = found;
        if (found) extensionSigner = window.nostr;
        useLocalKey(priv).then(resolve);
      });
      return;
    }
    detectExtension(10, function (found) {
      api.extensionAvailable = found;
      if (found && mode === 'extension' && load(K_PUB)) {
        api.loginWithExtension().then(resolve, function () { resolve(null); });
      } else {
        resolve(null);
      }
    });
  });
})();
