/* The account corner in the header.
 *
 * The markup is static in every page and the logged-in state is painted by CSS
 * from what js/session.js read out of this browser, so nothing flashes and the
 * corner looks the same everywhere. This script only adds what CSS cannot do:
 * the profile picture, and, on the pages that talk to the relays, the unread
 * count and live profile updates.
 */
(function () {
  'use strict';

  var S = window.SemRedeSession;
  if (!S) return;

  var bar = document.querySelector('.site-header .account-bar');
  if (!bar) return;

  var me = bar.querySelector('.acct-me');
  var avatar = me && me.querySelector('.avatar');
  var mail = bar.querySelector('.acct-mail');
  var badge = mail && mail.querySelector('.acct-badge');

  function paintAvatar() {
    if (!avatar) return;
    var profile = S.profile();
    var url = profile && profile.picture;
    var img = avatar.querySelector('img');
    if (!url) {
      if (img) img.remove();
      return;
    }
    if (img && img.getAttribute('src') === url) return;
    if (!img) {
      img = document.createElement('img');
      img.alt = '';
      img.width = 32;
      img.height = 32;
      img.decoding = 'async';
      // Somebody else's server hosts this picture, so it learns nothing about
      // where on the site its owner is reading.
      img.referrerPolicy = 'no-referrer';
      img.addEventListener('error', function () { img.remove(); });
      avatar.appendChild(img);
    }
    img.src = url;
  }

  function paintBadge(n) {
    if (!badge) return;
    badge.hidden = !n;
    badge.textContent = n > 99 ? '99+' : String(n);
    if (mail) mail.title = n ? n + (n === 1 ? ' unread message' : ' unread messages') : 'Messages';
  }

  function refresh() {
    if (!S.pubkey) {
      if (avatar) {
        var img = avatar.querySelector('img');
        if (img) img.remove();
      }
      paintBadge(0);
      return;
    }
    paintAvatar();
  }

  // The relay pages load their bundle after this script, so wait for the page
  // to finish parsing before looking for them.
  function attachLive() {
    var net = window.SemRedeNet;
    var auth = window.SemRedeNostr;
    var dm = window.SemRedeDM;

    if (net && auth && auth.pubkey) {
      net.requestProfile(auth.pubkey);
      net.onProfile(function (pubkey) { if (pubkey === auth.pubkey) paintAvatar(); });
    }
    if (dm) {
      dm.onChange(function () { paintBadge(dm.unreadTotal()); });
      paintBadge(dm.unreadTotal());
    }
  }

  document.addEventListener('semrede-login', refresh);
  document.addEventListener('semrede-logout', refresh);
  document.addEventListener('semrede-profile', paintAvatar);

  refresh();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', attachLive);
  else attachLive();
})();
