/* SemRede forum: NIP-7D threads (kind 11) answered by NIP-22 comments (kind 1111).
 *
 * A thread carries a 'title' tag, the shared forum tag and one category tag
 * (semrede-tech, semrede-mesh, ...). Nothing has to be created in advance, so
 * the same categories carry over from one year to the next.
 *
 * Routes: #/           categories
 *         #/c/<slug>   threads in a category
 *         #/t/<id>     one thread
 */
(function () {
  'use strict';

  var NT = window.NostrTools;
  var cfg = window.SemRedeConfig;
  var net = window.SemRedeNet;
  var auth = window.SemRedeNostr;
  var pool = net.pool;
  var RELAYS = net.RELAYS;
  var TAG = cfg.FORUM_TAG;
  var CATS = cfg.CATEGORIES;
  var THREAD_KIND = 11;
  var COMMENT_KIND = 1111;
  var TITLE_MAX = 120;
  var BODY_MAX = 8000;

  var $ = function (id) { return document.getElementById(id); };
  var els = {
    views: {
      index: $('view-index'),
      category: $('view-category'),
      thread: $('view-thread')
    },
    catGrid: $('category-grid'),
    latest: $('latest-list'),
    catName: $('cat-name'), catAbout: $('cat-about'), catThreads: $('cat-threads'), catEmpty: $('cat-empty'),
    newForm: $('new-thread'), newTitle: $('new-title'), newBody: $('new-body'), newError: $('new-error'),
    newToggle: $('new-toggle'), newLocked: $('new-locked'),
    threadBody: $('thread-body'), threadTitle: $('thread-title'), threadCat: $('thread-cat'),
    comments: $('comments'), replyForm: $('reply-form'), replyBody: $('reply-body'), replyLocked: $('reply-locked'),
    relayDots: $('relay-dots'), relayCount: $('relay-count'),
    loading: $('forum-loading')
  };

  var threads = new Map();   // id -> kind 11 event
  var comments = new Map();  // id -> kind 1111 event
  var counts = new Map();    // thread id -> {replies, last}
  var route = { view: 'index', slug: null, id: null };
  var threadSub = null;
  var countedIds = new Set();

  function catBySlug(slug) {
    return CATS.filter(function (c) { return c.slug === slug; })[0] || null;
  }

  function tagValue(ev, name) {
    for (var i = 0; i < ev.tags.length; i++) if (ev.tags[i][0] === name) return ev.tags[i][1];
    return '';
  }

  function threadCategory(ev) {
    var slug = null;
    ev.tags.forEach(function (t) {
      if (t[0] !== 't') return;
      var v = String(t[1] || '');
      if (v.indexOf(TAG + '-') === 0 && catBySlug(v.slice(TAG.length + 1))) slug = v.slice(TAG.length + 1);
    });
    return slug;
  }

  function threadTitle(ev) {
    var t = tagValue(ev, 'title').trim();
    if (t) return t.slice(0, TITLE_MAX);
    return (ev.content || '').trim().split('\n')[0].slice(0, 80) || 'Untitled';
  }

  function isThread(ev) {
    return ev.kind === THREAD_KIND && !net.isMuted(ev.pubkey) && !!threadCategory(ev) &&
      ev.created_at < Date.now() / 1000 + 600;
  }

  function visibleThreads(slug) {
    return Array.from(threads.values())
      .filter(function (ev) { return isThread(ev) && (!slug || threadCategory(ev) === slug); })
      .sort(function (a, b) { return lastActivity(b) - lastActivity(a); });
  }

  function lastActivity(ev) {
    var c = counts.get(ev.id);
    return c && c.last ? Math.max(c.last, ev.created_at) : ev.created_at;
  }

  function replyCount(id) {
    var c = counts.get(id);
    return c ? c.replies : 0;
  }

  // ---------- building blocks ----------

  function authorLine(ev, extraText) {
    var wrap = document.createElement('div');
    wrap.className = 'author';
    var avatar = document.createElement('span');
    avatar.className = 'avatar';
    net.fillAvatar(avatar, ev.pubkey);
    var name = document.createElement('span');
    name.className = 'author-name';
    name.textContent = net.displayName(ev.pubkey);
    name.style.color = net.colorFor(ev.pubkey);
    var cs = document.createElement('span');
    cs.className = 'callsign';
    cs.textContent = auth.deriveCallsign(ev.pubkey);
    cs.title = NT.nip19.npubEncode(ev.pubkey);
    var time = document.createElement('time');
    time.dateTime = new Date(ev.created_at * 1000).toISOString();
    time.textContent = net.ago(ev.created_at);
    time.title = net.dayLabel(ev.created_at) + ', ' + net.timeLabel(ev.created_at);
    wrap.append(avatar, name, cs, time);
    if (extraText) {
      var extra = document.createElement('span');
      extra.className = 'author-extra';
      extra.textContent = extraText;
      wrap.appendChild(extra);
    }
    net.requestProfile(ev.pubkey);
    return wrap;
  }

  function bodyNode(text) {
    var body = document.createElement('div');
    body.className = 'post-body';
    net.renderText(body, text);
    return body;
  }

  // ---------- index ----------

  function renderIndex() {
    els.catGrid.textContent = '';
    CATS.forEach(function (cat) {
      var list = visibleThreads(cat.slug);
      var card = document.createElement('a');
      card.className = 'cat-card c-' + cat.color;
      card.href = '#/c/' + cat.slug;
      var h = document.createElement('h2');
      h.textContent = cat.name;
      var about = document.createElement('p');
      about.textContent = cat.about;
      var stat = document.createElement('span');
      stat.className = 'cat-stat';
      var replies = list.reduce(function (n, t) { return n + replyCount(t.id); }, 0);
      stat.textContent = list.length === 0 ? 'No threads yet'
        : list.length + (list.length === 1 ? ' thread' : ' threads') + ', ' + replies + (replies === 1 ? ' reply' : ' replies');
      card.append(h, about, stat);
      els.catGrid.appendChild(card);
    });

    var recent = visibleThreads(null).slice(0, 8);
    els.latest.textContent = '';
    if (!recent.length) {
      var none = document.createElement('p');
      none.className = 'muted-note';
      none.textContent = 'Nothing has been posted yet. The first thread can be yours.';
      els.latest.appendChild(none);
      return;
    }
    recent.forEach(function (ev) { els.latest.appendChild(threadRow(ev, true)); });
  }

  function threadRow(ev, withCategory) {
    var row = document.createElement('a');
    row.className = 'thread-row';
    row.href = '#/t/' + ev.id;
    var main = document.createElement('div');
    var title = document.createElement('strong');
    title.textContent = threadTitle(ev);
    main.appendChild(title);
    var meta = document.createElement('div');
    meta.className = 'thread-meta';
    var bits = [net.displayName(ev.pubkey), net.ago(lastActivity(ev))];
    if (withCategory) {
      var cat = catBySlug(threadCategory(ev));
      if (cat) bits.unshift(cat.name);
    }
    meta.textContent = bits.join(' / ');
    main.appendChild(meta);
    var count = document.createElement('span');
    count.className = 'reply-count';
    count.textContent = replyCount(ev.id);
    count.title = replyCount(ev.id) === 1 ? '1 reply' : replyCount(ev.id) + ' replies';
    row.append(main, count);
    net.requestProfile(ev.pubkey);
    return row;
  }

  // ---------- category ----------

  function renderCategory() {
    var cat = catBySlug(route.slug);
    if (!cat) return go('#/');
    els.catName.textContent = cat.name;
    els.catAbout.textContent = cat.about;
    var list = visibleThreads(cat.slug);
    els.catThreads.textContent = '';
    list.forEach(function (ev) { els.catThreads.appendChild(threadRow(ev, false)); });
    els.catEmpty.hidden = list.length > 0;
  }

  // ---------- thread ----------

  function renderThread() {
    var ev = threads.get(route.id);
    els.threadBody.textContent = '';
    if (!ev) {
      var loading = document.createElement('p');
      loading.className = 'muted-note';
      loading.textContent = 'Looking for this thread on the relays...';
      els.threadBody.appendChild(loading);
      els.threadTitle.textContent = 'Thread';
      els.comments.textContent = '';
      return;
    }
    var cat = catBySlug(threadCategory(ev));
    els.threadTitle.textContent = threadTitle(ev);
    els.threadCat.textContent = cat ? cat.name : 'Forum';
    els.threadCat.href = cat ? '#/c/' + cat.slug : '#/';

    var post = document.createElement('article');
    post.className = 'post root';
    post.append(authorLine(ev), bodyNode(ev.content));
    els.threadBody.appendChild(post);

    renderComments(ev);
  }

  // Comments keep their parent in a lowercase 'e' tag (NIP-22), so the tree is
  // rebuilt from those; anything whose parent is missing hangs off the root.
  function renderComments(root) {
    var mine = Array.from(comments.values()).filter(function (c) {
      return !net.isMuted(c.pubkey) && c.tags.some(function (t) { return t[0] === 'E' && t[1] === root.id; });
    });
    var byParent = new Map();
    var known = new Set(mine.map(function (c) { return c.id; }));
    mine.forEach(function (c) {
      var parent = root.id;
      for (var i = 0; i < c.tags.length; i++) {
        if (c.tags[i][0] === 'e' && known.has(c.tags[i][1])) { parent = c.tags[i][1]; break; }
      }
      if (!byParent.has(parent)) byParent.set(parent, []);
      byParent.get(parent).push(c);
    });

    els.comments.textContent = '';
    var total = mine.length;
    var heading = document.createElement('h3');
    heading.className = 'comments-heading';
    heading.textContent = total === 0 ? 'No replies yet' : total === 1 ? '1 reply' : total + ' replies';
    els.comments.appendChild(heading);

    (function walk(parentId, depth) {
      var kids = (byParent.get(parentId) || []).sort(function (a, b) { return a.created_at - b.created_at; });
      kids.forEach(function (c) {
        els.comments.appendChild(commentNode(c, Math.min(depth, 4), root));
        walk(c.id, depth + 1);
      });
    })(root.id, 0);
  }

  function commentNode(ev, depth, root) {
    var wrap = document.createElement('article');
    wrap.className = 'post comment depth-' + depth;
    wrap.append(authorLine(ev), bodyNode(ev.content));

    var actions = document.createElement('div');
    actions.className = 'post-actions';
    var reply = document.createElement('button');
    reply.type = 'button';
    reply.className = 'text-btn';
    reply.textContent = 'Reply';
    reply.addEventListener('click', function () {
      if (!auth.pubkey) return go('#/t/' + root.id, '#join');
      openInlineReply(wrap, ev, root);
    });
    actions.appendChild(reply);
    wrap.appendChild(actions);
    return wrap;
  }

  function openInlineReply(container, parent, root) {
    if (container.querySelector('.inline-reply')) return;
    var form = document.createElement('form');
    form.className = 'inline-reply';
    var area = document.createElement('textarea');
    area.rows = 3;
    area.maxLength = BODY_MAX;
    area.placeholder = 'Reply to ' + net.displayName(parent.pubkey);
    var row = document.createElement('div');
    row.className = 'inline-row';
    var send = document.createElement('button');
    send.type = 'submit';
    send.className = 'small-btn';
    send.textContent = 'Reply';
    var cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'text-btn';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', function () { form.remove(); });
    row.append(send, cancel);
    form.append(area, row);
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var text = area.value.trim();
      if (!text) return;
      send.disabled = true;
      postComment(text, parent, root).then(function () { form.remove(); }, function () { send.disabled = false; });
    });
    container.appendChild(form);
    area.focus();
  }

  // ---------- publishing ----------

  function postThread(title, body, slug) {
    return auth.signEvent({
      kind: THREAD_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['title', title], ['t', TAG], ['t', TAG + '-' + slug]],
      content: body
    }).then(function (ev) {
      if (!NT.verifyEvent(ev)) throw new Error('Signature check failed');
      threads.set(ev.id, ev);
      return net.publish(ev).then(function (ok) {
        if (!ok) throw new Error('No relay accepted the thread');
        go('#/t/' + ev.id);
        return ev;
      });
    });
  }

  function postComment(text, parent, root) {
    var relay = RELAYS[0];
    var tags = [
      ['E', root.id, relay, root.pubkey],
      ['K', String(THREAD_KIND)],
      ['P', root.pubkey, relay],
      ['e', parent.id, relay, parent.pubkey],
      ['k', String(parent.kind)],
      ['p', parent.pubkey, relay]
    ];
    return auth.signEvent({ kind: COMMENT_KIND, created_at: Math.floor(Date.now() / 1000), tags: tags, content: text })
      .then(function (ev) {
        if (!NT.verifyEvent(ev)) throw new Error('Signature check failed');
        comments.set(ev.id, ev);
        bumpCount(root.id, ev.created_at);
        renderComments(root);
        return net.publish(ev).then(function (ok) {
          if (!ok) throw new Error('No relay accepted the reply');
        });
      });
  }

  // ---------- relay traffic ----------

  function bumpCount(threadId, at) {
    var c = counts.get(threadId) || { replies: 0, last: 0 };
    c.replies += 1;
    if (at > c.last) c.last = at;
    counts.set(threadId, c);
  }

  function addThread(ev) {
    if (threads.has(ev.id) || ev.kind !== THREAD_KIND) return;
    threads.set(ev.id, ev);
    net.requestProfile(ev.pubkey);
    scheduleCounts();
    queueRender();
  }

  function addComment(ev) {
    if (comments.has(ev.id) || ev.kind !== COMMENT_KIND) return;
    comments.set(ev.id, ev);
    net.requestProfile(ev.pubkey);
    var rootTag = ev.tags.filter(function (t) { return t[0] === 'E'; })[0];
    if (rootTag && !countedIds.has(ev.id)) {
      countedIds.add(ev.id);
      bumpCount(rootTag[1], ev.created_at);
    }
    queueRender();
  }

  // Reply counts for the lists: one query per batch of new threads.
  var countTimer = null;
  var counted = new Set();
  function scheduleCounts() {
    clearTimeout(countTimer);
    countTimer = setTimeout(function () {
      var ids = Array.from(threads.keys()).filter(function (id) { return !counted.has(id); });
      if (!ids.length) return;
      ids.forEach(function (id) { counted.add(id); });
      for (var i = 0; i < ids.length; i += 50) {
        pool.subscribeManyEose(RELAYS, { kinds: [COMMENT_KIND], '#E': ids.slice(i, i + 50) }, {
          onevent: addComment,
          onclose: function () { queueRender(); }
        });
      }
    }, 400);
  }

  function watchForum() {
    pool.subscribeMany(RELAYS, { kinds: [THREAD_KIND], '#t': [TAG], limit: 300 }, {
      onevent: addThread,
      oneose: function () {
        els.loading.hidden = true;
        queueRender();
      }
    });
    setTimeout(function () { els.loading.hidden = true; queueRender(); }, 8000);
    net.watchMuteList();
  }

  function watchThread(id) {
    if (threadSub) { threadSub.close(); threadSub = null; }
    if (!threads.has(id)) {
      pool.get(RELAYS, { ids: [id] }, { maxWait: 6000 }).then(function (ev) {
        if (ev && ev.kind === THREAD_KIND) { addThread(ev); queueRender(); }
      });
    }
    threadSub = pool.subscribeMany(RELAYS, { kinds: [COMMENT_KIND], '#E': [id], limit: 500 }, {
      onevent: addComment
    });
  }

  // ---------- routing and render loop ----------

  function parseHash() {
    var h = location.hash.replace(/^#\/?/, '');
    var parts = h.split('/');
    if (parts[0] === 'c' && parts[1]) return { view: 'category', slug: parts[1], id: null };
    if (parts[0] === 't' && parts[1]) return { view: 'thread', slug: null, id: parts[1] };
    return { view: 'index', slug: null, id: null };
  }

  function go(hash, anchor) {
    location.hash = hash;
    if (anchor) setTimeout(function () { location.hash = anchor; }, 0);
  }

  function applyRoute() {
    var next = parseHash();
    var changed = next.view !== route.view || next.slug !== route.slug || next.id !== route.id;
    route = next;
    Object.keys(els.views).forEach(function (name) {
      els.views[name].hidden = name !== route.view;
    });
    if (route.view === 'thread') watchThread(route.id);
    else if (threadSub) { threadSub.close(); threadSub = null; }
    if (route.view === 'category' && els.newForm) els.newForm.reset();
    updateComposerVisibility();
    render();
    if (changed) window.scrollTo({ top: 0, behavior: 'auto' });
  }

  var queued = false;
  function queueRender() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(function () { queued = false; render(); });
  }

  function render() {
    if (route.view === 'index') renderIndex();
    else if (route.view === 'category') renderCategory();
    else renderThread();
  }

  function updateComposerVisibility() {
    var loggedIn = !!auth.pubkey;
    if (els.newToggle) els.newToggle.hidden = !loggedIn;
    if (els.newLocked) els.newLocked.hidden = loggedIn;
    if (els.newForm && !loggedIn) els.newForm.hidden = true;
    if (els.replyForm) els.replyForm.hidden = !loggedIn;
    if (els.replyLocked) els.replyLocked.hidden = loggedIn;
  }

  function wire() {
    window.addEventListener('hashchange', applyRoute);

    els.newToggle.addEventListener('click', function () {
      els.newForm.hidden = !els.newForm.hidden;
      if (!els.newForm.hidden) els.newTitle.focus();
    });

    els.newForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var title = els.newTitle.value.replace(/\s+/g, ' ').trim();
      var body = els.newBody.value.trim();
      if (title.length < 4) return window.SemRedeIdentity.showError(els.newError, 'Give the thread a title of at least 4 characters.');
      if (!body) return window.SemRedeIdentity.showError(els.newError, 'Write something in the body.');
      var btn = els.newForm.querySelector('button[type=submit]');
      btn.disabled = true;
      postThread(title.slice(0, TITLE_MAX), body.slice(0, BODY_MAX), route.slug)
        .then(function () { els.newForm.reset(); els.newForm.hidden = true; })
        .catch(function (err) { window.SemRedeIdentity.showError(els.newError, err.message || 'Could not post the thread.'); })
        .finally(function () { btn.disabled = false; });
    });

    els.replyForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var root = threads.get(route.id);
      var text = els.replyBody.value.trim();
      if (!root || !text) return;
      var btn = els.replyForm.querySelector('button[type=submit]');
      btn.disabled = true;
      postComment(text, root, root)
        .then(function () { els.replyBody.value = ''; })
        .finally(function () { btn.disabled = false; });
    });

    window.SemRedeIdentity.onChange(function () { updateComposerVisibility(); queueRender(); });
    net.onProfile(function () { queueRender(); });
    net.onMuteChange(function () { queueRender(); });
  }

  wire();
  applyRoute();
  watchForum();
  net.relayStatus(els.relayDots, els.relayCount);
})();
