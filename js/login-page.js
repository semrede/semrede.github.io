/* /login: swaps the heading between the two states of the identity cards and
 * sends people back where they came from after logging in.
 */
(function () {
  'use strict';

  var auth = window.SemRedeNostr;
  var h1 = document.getElementById('account-h1');

  // ?next=/chat lets the chat and forum bring people back after a login.
  function nextTarget() {
    var m = /[?&]next=([^&]+)/.exec(location.search);
    if (!m) return null;
    var value = decodeURIComponent(m[1]);
    return /^\/[a-z0-9/_-]*$/i.test(value) ? value : null;
  }

  function update() {
    var loggedIn = !!auth.pubkey;
    h1.textContent = loggedIn ? 'Your account' : 'Log in';
    document.title = loggedIn ? 'SemRede account' : 'SemRede login';
  }

  document.addEventListener('semrede-login', function () {
    update();
    var next = nextTarget();
    if (next) setTimeout(function () { location.href = next; }, 600);
  });
  document.addEventListener('semrede-logout', update);
  auth.ready.then(update);
  update();
})();
