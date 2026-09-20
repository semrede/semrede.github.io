/* Phone navigation: on narrow screens the header links move into a panel
 * behind a three-line button, so nothing is dropped from the menu.
 */
(function () {
  'use strict';

  var header = document.querySelector('.site-header');
  var nav = header && header.querySelector('nav');
  if (!nav) return;

  var button = document.createElement('button');
  button.type = 'button';
  button.className = 'nav-toggle';
  button.setAttribute('aria-label', 'Menu');
  button.setAttribute('aria-expanded', 'false');
  button.innerHTML = '<span></span><span></span><span></span>';

  var panel = document.createElement('div');
  panel.className = 'nav-panel';
  panel.hidden = true;

  function fill() {
    panel.textContent = '';
    nav.querySelectorAll('a').forEach(function (link) {
      if (link.closest('.account-bar')) return;
      var copy = document.createElement('a');
      copy.href = link.getAttribute('href');
      copy.textContent = link.textContent.trim();
      if (link.getAttribute('aria-current')) copy.setAttribute('aria-current', 'page');
      panel.appendChild(copy);
    });
  }

  function open(state) {
    panel.hidden = !state;
    button.classList.toggle('open', state);
    button.setAttribute('aria-expanded', state ? 'true' : 'false');
  }

  button.addEventListener('click', function (e) {
    e.stopPropagation();
    if (panel.hidden) fill();
    open(panel.hidden);
  });

  panel.addEventListener('click', function () { open(false); });
  document.addEventListener('click', function (e) {
    if (!panel.hidden && !panel.contains(e.target) && e.target !== button) open(false);
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') open(false);
  });
  window.addEventListener('resize', function () { if (window.innerWidth > 800) open(false); });

  nav.appendChild(button);
  header.appendChild(panel);
})();
