/* Account corner for the home page. The marketing page does not load the NOSTR
 * bundle, so this only reads whether a key is stored and links to the pages.
 * No unread count here; that needs the relays, which /chat and /forum have.
 */
(function () {
  'use strict';

  var bar = document.querySelector('.account-bar');
  if (!bar) return;

  var loggedIn = false;
  try { loggedIn = !!localStorage.getItem('semrede_nostr_pubkey'); } catch (e) { loggedIn = false; }
  if (!loggedIn) return;

  bar.textContent = '';

  var mail = document.createElement('a');
  mail.className = 'acct-mail';
  mail.href = '/messages';
  mail.title = 'Messages';
  mail.setAttribute('aria-label', 'Messages');
  mail.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">' +
    '<rect x="2.5" y="5" width="19" height="14" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.8"/>' +
    '<path d="M3 6.5l9 6 9-6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  var account = document.createElement('a');
  account.className = 'acct-btn';
  account.href = '/login';
  account.textContent = 'Account';

  bar.append(mail, account);
})();
