/* Translation overlay.
 *
 * The pages are written in English and stay that way. A dictionary keyed by the
 * English text (js/i18n-pt.js) is laid over the page at runtime, so nothing has
 * to be duplicated or kept in sync: a string that has no translation simply
 * stays in English.
 *
 * Language: ?lang=pt wins, then a choice saved in this browser, then the
 * browser's own languages. English is the default.
 *
 * Text that the scripts build later (chat messages, forum lists, counters) is
 * translated too, because a MutationObserver keeps watching. Strings with
 * numbers in them are handled by the pattern list at the end of the dictionary.
 */
(function () {
  'use strict';

  var STORE = 'semrede_lang';
  var ATTRS = ['placeholder', 'title', 'aria-label', 'alt', 'value'];

  function pick() {
    var param = /[?&]lang=([a-z-]+)/i.exec(location.search);
    if (param) {
      var asked = param[1].toLowerCase().slice(0, 2);
      try { localStorage.setItem(STORE, asked); } catch (e) { /* private mode */ }
      return asked;
    }
    var saved;
    try { saved = localStorage.getItem(STORE); } catch (e) { saved = null; }
    if (saved) return saved;
    var list = navigator.languages || [navigator.language || 'en'];
    for (var i = 0; i < list.length; i++) {
      var code = String(list[i]).toLowerCase();
      if (code.indexOf('pt') === 0) return 'pt';
      if (code.indexOf('en') === 0) return 'en';
    }
    return 'en';
  }

  var lang = pick();
  var dict = (window.SemRedeDict && window.SemRedeDict[lang]) || null;
  // Empty until a dictionary is laid over the page, so t() works in English too.
  var exact = {};
  var patterns = [];

  var api = window.SemRedeI18n = {
    lang: lang,
    // Available to any script that builds its own strings.
    t: function (text) { return translate(text) || text; },
    set: function (next) {
      try { localStorage.setItem(STORE, next); } catch (e) { /* private mode */ }
      location.reload();
    }
  };

  document.documentElement.lang = lang;

  // The EN / PT buttons in the footer. Delegated, because the footer is not
  // parsed yet when this runs.
  document.addEventListener('click', function (e) {
    var button = e.target.closest && e.target.closest('.lang-switch [data-lang]');
    if (button) api.set(button.getAttribute('data-lang'));
  });

  function markSwitch() {
    var buttons = document.querySelectorAll('.lang-switch [data-lang]');
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].classList.toggle('current', buttons[i].getAttribute('data-lang') === lang);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', markSwitch);
  else markSwitch();

  if (!dict) return;

  exact = dict.exact || {};
  patterns = (dict.patterns || []).map(function (pair) {
    return [new RegExp('^' + pair[0] + '$'), pair[1]];
  });

  function translate(text) {
    var trimmed = text.trim();
    if (!trimmed) return null;
    var hit = exact[trimmed];
    if (hit) return hit;
    for (var i = 0; i < patterns.length; i++) {
      var m = patterns[i][0].exec(trimmed);
      if (m) {
        return patterns[i][1].replace(/\$(\d)/g, function (_, n) { return m[Number(n)]; });
      }
    }
    return null;
  }

  function translateTextNode(node) {
    var value = node.nodeValue;
    if (!value || !value.trim()) return;
    var hit = translate(value);
    if (!hit) return;
    // keep the whitespace that surrounded the sentence
    var lead = value.match(/^\s*/)[0];
    var tail = value.match(/\s*$/)[0];
    // Writing the same text again would queue another mutation record, and the
    // observer would come straight back here: only write a real change.
    if (lead + hit + tail === value) return;
    node.nodeValue = lead + hit + tail;
  }

  function translateElement(el) {
    if (el.nodeType !== 1) return;
    for (var i = 0; i < ATTRS.length; i++) {
      var attr = ATTRS[i];
      if (!el.hasAttribute(attr)) continue;
      if (attr === 'value' && el.tagName !== 'BUTTON' && el.type !== 'submit' && el.type !== 'button') continue;
      var value = el.getAttribute(attr);
      var hit = translate(value);
      if (hit && hit !== value) el.setAttribute(attr, hit);
    }
  }

  var SKIP = { SCRIPT: 1, STYLE: 1, CODE: 1, TEXTAREA: 1 };

  function walk(node) {
    if (node.nodeType === 3) return translateTextNode(node);
    if (node.nodeType !== 1) return;
    // A textarea holds what someone is typing, so only its placeholder is ours
    // to touch; script and style hold no prose at all.
    translateElement(node);
    if (SKIP[node.tagName]) return;
    for (var child = node.firstChild; child; child = child.nextSibling) walk(child);
  }

  function run() {
    walk(document.documentElement);
    var title = document.querySelector('title');
    if (title) translateTextNode(title.firstChild || title);
  }

  // Translate as the page is parsed, so nothing shows up in English first.
  new MutationObserver(function (records) {
    records.forEach(function (record) {
      if (record.type === 'characterData') return translateTextNode(record.target);
      for (var i = 0; i < record.addedNodes.length; i++) walk(record.addedNodes[i]);
    });
  }).observe(document.documentElement, { childList: true, subtree: true, characterData: true });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
  else run();
})();
