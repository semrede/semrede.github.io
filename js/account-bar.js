/* The account corner in the header: "Log in" when signed out, and when signed
 * in an envelope with the unread count plus the account chip.
 * Added by script so every app page gets the same one.
 */
(function () {
  'use strict';

  var net = window.SemRedeNet;
  var auth = window.SemRedeNostr;
  var dm = window.SemRedeDM;

  var nav = document.querySelector('.site-header nav');
  if (!nav) return;

  // A page may already carry a static bar (the marketing pages do); reuse it.
  var bar = nav.querySelector('.account-bar');
  var isNew = !bar;
  if (isNew) {
    bar = document.createElement('div');
    bar.className = 'account-bar';
  } else {
    bar.textContent = '';
  }

  var login = document.createElement('a');
  login.className = 'acct-btn';
  login.href = '/login';
  login.textContent = 'Log in';

  var mail = document.createElement('a');
  mail.className = 'acct-mail';
  mail.href = '/messages';
  mail.title = 'Messages';
  mail.setAttribute('aria-label', 'Messages');
  mail.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">' +
    '<rect x="2.5" y="5" width="19" height="14" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.8"/>' +
    '<path d="M3 6.5l9 6 9-6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var badge = document.createElement('span');
  badge.className = 'acct-badge';
  badge.hidden = true;
  mail.appendChild(badge);

  var chip = document.createElement('a');
  chip.className = 'acct-chip';
  chip.href = '/login';
  var chipAvatar = document.createElement('span');
  chipAvatar.className = 'avatar';
  var chipName = document.createElement('span');
  chipName.className = 'acct-name';
  chip.append(chipAvatar, chipName);

  bar.append(login, mail, chip);
  if (isNew) nav.appendChild(bar);

  function refresh() {
    var loggedIn = !!auth.pubkey;
    login.hidden = loggedIn;
    mail.hidden = !loggedIn;
    chip.hidden = !loggedIn;
    if (!loggedIn) return;
    net.requestProfile(auth.pubkey);
    net.fillAvatar(chipAvatar, auth.pubkey);
    chipName.textContent = net.displayName(auth.pubkey);
    updateBadge();
  }

  function updateBadge() {
    if (!dm || !auth.pubkey) return;
    var n = dm.unreadTotal();
    badge.hidden = n === 0;
    badge.textContent = n > 99 ? '99+' : String(n);
    mail.title = n === 0 ? 'Messages' : n + (n === 1 ? ' unread message' : ' unread messages');
  }

  document.addEventListener('semrede-login', refresh);
  document.addEventListener('semrede-logout', refresh);
  net.onProfile(function (pubkey) { if (pubkey === auth.pubkey) refresh(); });
  if (dm) dm.onChange(updateBadge);
  refresh();
})();
