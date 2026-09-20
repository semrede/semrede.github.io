/* /share: copy buttons, the phone share sheet, and posting the flyer on NOSTR
 * with the visitor's own key.
 */
(function () {
  'use strict';

  var NT = window.NostrTools;
  var net = window.SemRedeNet;
  var auth = window.SemRedeNostr;

  var SITE = 'https://semrede.com';
  var FLYER = SITE + '/files/semrede-2026-flyer.png';
  var MESSAGE = 'SemRede 2026: offgrid communications, communities and people. ' +
    'October 26 to 31 in Coimbra, Portugal. Free, but register so they know how many to cook for. ' + SITE;

  var $ = function (id) { return document.getElementById(id); };
  var els = {
    message: $('share-message'), copyText: $('copy-text'), copyLink: $('copy-link'),
    native: $('share-native'), nostr: $('share-nostr'), nostrNote: $('nostr-note'), status: $('share-status')
  };

  function status(msg, kind) {
    if (!els.status) return;
    els.status.textContent = msg || '';
    els.status.className = 'share-status' + (kind ? ' ' + kind : '');
    clearTimeout(els.status._t);
    els.status._t = setTimeout(function () { els.status.textContent = ''; }, 6000);
  }

  function copy(text, button, label) {
    navigator.clipboard.writeText(text).then(function () {
      var old = button.textContent;
      button.textContent = 'Copied';
      setTimeout(function () { button.textContent = old; }, 1600);
    }, function () {
      status('Could not reach the clipboard. Select the text and copy it by hand.', 'bad');
    });
  }

  if (els.copyText) els.copyText.addEventListener('click', function () {
    copy(els.message.value, els.copyText);
  });
  if (els.copyLink) els.copyLink.addEventListener('click', function () {
    copy(SITE, els.copyLink);
  });

  // The phone share sheet, when the browser has one.
  if (els.native) {
    if (navigator.share) {
      els.native.hidden = false;
      els.native.addEventListener('click', function () {
        navigator.share({ title: 'SemRede 2026', text: els.message.value, url: SITE }).catch(function () {});
      });
    } else {
      els.native.hidden = true;
    }
  }

  // Posting on NOSTR uses the account this site already knows about.
  function updateNostrButton() {
    if (!els.nostr) return;
    els.nostr.textContent = auth.pubkey ? 'Post it on NOSTR' : 'Log in to post it on NOSTR';
  }

  if (els.nostr) els.nostr.addEventListener('click', function () {
    if (!auth.pubkey) {
      location.href = '/login?next=/share';
      return;
    }
    els.nostr.disabled = true;
    status('Signing...');
    var text = els.message.value.trim() + '\n\n' + FLYER;
    auth.signEvent({
      kind: 1,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['t', 'semrede'], ['r', SITE], ['imeta', 'url ' + FLYER, 'm image/png']],
      content: text
    }).then(function (ev) {
      if (!NT.verifyEvent(ev)) throw new Error('Signature check failed');
      return net.publish(ev).then(function (ok) {
        if (!ok) throw new Error('No relay accepted the post');
        status('Posted. Thank you.', 'ok');
        if (els.nostrNote) {
          els.nostrNote.textContent = '';
          var link = document.createElement('a');
          link.href = 'https://njump.me/' + NT.nip19.noteEncode(ev.id);
          link.target = '_blank';
          link.rel = 'noopener';
          link.textContent = 'See your post';
          els.nostrNote.appendChild(link);
        }
      });
    }).catch(function (err) {
      status(err.message || 'Could not post it', 'bad');
    }).finally(function () {
      els.nostr.disabled = false;
    });
  });

  document.addEventListener('semrede-login', updateNostrButton);
  document.addEventListener('semrede-logout', updateNostrButton);
  auth.ready.then(updateNostrButton);
  updateNostrButton();
})();
