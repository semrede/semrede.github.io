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
  var mod = window.SemRedeMod;
  var blossom = window.SemRedeBlossom;
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
    sortRecent: $('sort-recent'), sortTop: $('sort-top'),
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
  var votes = new Map();     // target id -> Map(pubkey -> reaction event id)
  var deleted = new Set();   // ids their own author asked to delete (NIP-09)
  var edits = new Map();     // original id -> newest replacement by the same author
  var sortBy = 'recent';
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

  // An edit is a new event carrying an 'edit' tag with the id it replaces, by
  // the same author. Other clients still show the original; here the newest
  // version wins and the post is marked as edited.
  function latest(ev) {
    var replacement = edits.get(ev.id);
    return replacement || ev;
  }

  function isEdited(ev) {
    return edits.has(ev.id);
  }

  function noteEdit(ev) {
    var original = tagValue(ev, 'edit');
    if (!original) return false;
    var target = threads.get(original) || comments.get(original);
    if (target && target.pubkey !== ev.pubkey) return true;   // not yours to edit
    var current = edits.get(original);
    if (!current || current.created_at < ev.created_at) edits.set(original, ev);
    return true;
  }

  function isHidden(ev) {
    return deleted.has(ev.id) || mod.isHidden(ev.id) || net.isMuted(ev.pubkey);
  }

  function voteCount(id) {
    var m = votes.get(id);
    return m ? m.size : 0;
  }

  function myVote(id) {
    var m = votes.get(id);
    return (m && auth.pubkey && m.get(auth.pubkey)) || null;
  }

  function isThread(ev) {
    return ev.kind === THREAD_KIND && !isHidden(ev) && !tagValue(ev, 'edit') && !!threadCategory(ev) &&
      ev.created_at < Date.now() / 1000 + 600;
  }

  function visibleThreads(slug, order) {
    var list = Array.from(threads.values())
      .filter(function (ev) { return isThread(ev) && (!slug || threadCategory(ev) === slug); });
    if (order === 'top') {
      list.sort(function (a, b) {
        return (voteCount(b.id) - voteCount(a.id)) || (lastActivity(b) - lastActivity(a));
      });
    } else {
      list.sort(function (a, b) { return lastActivity(b) - lastActivity(a); });
    }
    list.sort(function (a, b) { return (mod.isPinned(b.id) ? 1 : 0) - (mod.isPinned(a.id) ? 1 : 0); });
    return list;
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

  // Pictures travel as a URL in the text, the usual way on NOSTR. The file goes
  // to a Blossom server and the link is appended to whatever is being written.
  function pictureButton(textarea, onMeta) {
    var wrap = document.createElement('span');
    wrap.className = 'pic-btn-wrap';
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.hidden = true;
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'text-btn';
    button.textContent = 'Add a picture';
    var status = document.createElement('span');
    status.className = 'pic-status';

    button.addEventListener('click', function () { input.click(); });
    input.addEventListener('change', function () {
      var file = input.files && input.files[0];
      input.value = '';
      if (!file) return;
      button.disabled = true;
      status.textContent = 'Uploading...';
      blossom.upload(file).then(function (result) {
        var text = textarea.value.replace(/\s*$/, '');
        textarea.value = (text ? text + '\n\n' : '') + result.url + '\n';
        textarea.dispatchEvent(new Event('input'));
        textarea.focus();
        status.textContent = '';
        if (onMeta) onMeta(result);
      }).catch(function (err) {
        status.textContent = err.message || 'Upload failed';
      }).finally(function () {
        button.disabled = false;
      });
    });

    wrap.append(button, input, status);
    return wrap;
  }

  function badge(text, kind) {
    var b = document.createElement('span');
    b.className = 'thread-badge ' + kind;
    b.textContent = text;
    return b;
  }

  function moderatorActions(ev) {
    var wrap = document.createElement('span');
    wrap.className = 'mod-actions';
    if (!mod.isModerator(auth.pubkey)) return wrap;
    var pin = document.createElement('button');
    pin.type = 'button';
    pin.className = 'text-btn';
    pin.textContent = mod.isPinned(ev.id) ? 'Unpin' : 'Pin';
    pin.addEventListener('click', function () {
      pin.disabled = true;
      mod.setPinned(ev.id, !mod.isPinned(ev.id)).finally(function () { pin.disabled = false; queueRender(); });
    });
    var close = document.createElement('button');
    close.type = 'button';
    close.className = 'text-btn';
    close.textContent = mod.isClosed(ev.id) ? 'Reopen' : 'Close';
    close.title = 'A closed thread can be read but not answered';
    close.addEventListener('click', function () {
      close.disabled = true;
      mod.setClosed(ev.id, !mod.isClosed(ev.id)).finally(function () { close.disabled = false; queueRender(); });
    });
    wrap.append(pin, close);
    return wrap;
  }

  function voteButton(ev) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'vote-btn' + (myVote(ev.id) ? ' voted' : '');
    b.title = auth.pubkey ? 'Upvote this thread' : 'Log in to upvote';
    var arrow = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    arrow.setAttribute('class', 'vote-arrow');
    arrow.setAttribute('viewBox', '0 0 12 8');
    arrow.setAttribute('width', '12');
    arrow.setAttribute('height', '8');
    var tri = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    tri.setAttribute('d', 'M6 0L12 8H0z');
    tri.setAttribute('fill', 'currentColor');
    arrow.appendChild(tri);
    var n = document.createElement('span');
    n.className = 'vote-count';
    n.textContent = String(voteCount(ev.id));
    b.append(arrow, n);
    b.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      toggleVote(ev);
    });
    return b;
  }

  function ownerActions(ev, onEdit) {
    var wrap = document.createElement('span');
    wrap.className = 'owner-actions';
    if (!auth.pubkey || auth.pubkey !== ev.pubkey) return wrap;
    var edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'text-btn';
    edit.textContent = 'Edit';
    edit.addEventListener('click', onEdit);
    var del = document.createElement('button');
    del.type = 'button';
    del.className = 'text-btn danger';
    del.textContent = 'Delete';
    del.addEventListener('click', function () {
      if (!confirm('Delete this for everyone? Relays are asked to drop it, but copies may survive elsewhere.')) return;
      remove(ev);
    });
    wrap.append(edit, del);
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
    title.textContent = threadTitle(latest(ev));
    if (mod.isPinned(ev.id)) title.prepend(badge('Pinned', 'pinned'));
    if (mod.isClosed(ev.id)) title.append(badge('Closed', 'closed'));
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
    row.append(main, count, voteButton(ev));
    net.requestProfile(ev.pubkey);
    return row;
  }

  // ---------- category ----------

  function renderCategory() {
    var cat = catBySlug(route.slug);
    if (!cat) return go('#/');
    els.catName.textContent = cat.name;
    els.catAbout.textContent = cat.about;
    if (els.sortRecent && els.sortTop) {
      els.sortRecent.classList.toggle('chosen', sortBy === 'recent');
      els.sortTop.classList.toggle('chosen', sortBy === 'top');
    }
    var list = visibleThreads(cat.slug, sortBy);
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
    els.threadTitle.textContent = threadTitle(latest(ev));
    if (mod.isPinned(ev.id)) els.threadTitle.prepend(badge('Pinned', 'pinned'));
    if (mod.isClosed(ev.id)) els.threadTitle.append(badge('Closed', 'closed'));
    els.threadCat.textContent = cat ? cat.name : 'Forum';
    els.threadCat.href = cat ? '#/c/' + cat.slug : '#/';

    var shown = latest(ev);
    var post = document.createElement('article');
    post.className = 'post root';
    post.append(authorLine(ev, isEdited(ev) ? 'edited' : ''), bodyNode(shown.content));
    var actions = document.createElement('div');
    actions.className = 'post-actions';
    actions.append(voteButton(ev), ownerActions(ev, function () { openEditor(post, ev, true); }), moderatorActions(ev));
    post.appendChild(actions);
    els.threadBody.appendChild(post);

    renderComments(ev);
  }

  // Comments keep their parent in a lowercase 'e' tag (NIP-22), so the tree is
  // rebuilt from those; anything whose parent is missing hangs off the root.
  function renderComments(root) {
    var mine = Array.from(comments.values()).filter(function (c) {
      return !isHidden(c) && !tagValue(c, 'edit') &&
        c.tags.some(function (t) { return t[0] === 'E' && t[1] === root.id; });
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
    var shown = latest(ev);
    var wrap = document.createElement('article');
    wrap.className = 'post comment depth-' + depth;
    wrap.append(authorLine(ev, isEdited(ev) ? 'edited' : ''), bodyNode(shown.content));

    var actions = document.createElement('div');
    actions.className = 'post-actions';
    var reply = document.createElement('button');
    reply.type = 'button';
    reply.className = 'text-btn';
    reply.textContent = 'Reply';
    reply.addEventListener('click', function () {
      if (!auth.pubkey) { location.href = '/login?next=/forum'; return; }
      openInlineReply(wrap, ev, root);
    });
    if (!mod.isClosed(root.id)) actions.appendChild(reply);
    actions.appendChild(ownerActions(ev, function () { openEditor(wrap, ev, false); }));
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
    row.append(send, cancel, pictureButton(area));
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

  // ---------- editing, deleting, voting ----------

  // An edit keeps the original event in place (other clients still show it) and
  // publishes a replacement tagged with the id it supersedes.
  function openEditor(container, ev, isRoot) {
    if (container.querySelector('.inline-edit')) return;
    var current = latest(ev);
    var form = document.createElement('form');
    form.className = 'inline-edit';
    var title;
    if (isRoot) {
      title = document.createElement('input');
      title.type = 'text';
      title.maxLength = TITLE_MAX;
      title.value = threadTitle(current);
      form.appendChild(title);
    }
    var area = document.createElement('textarea');
    area.rows = 5;
    area.maxLength = BODY_MAX;
    area.value = current.content;
    var row = document.createElement('div');
    row.className = 'inline-row';
    var save = document.createElement('button');
    save.type = 'submit';
    save.className = 'small-btn';
    save.textContent = 'Save';
    var cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'text-btn';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', function () { form.remove(); });
    row.append(save, cancel);
    form.append(area, row);
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var body = area.value.trim();
      if (!body) return;
      save.disabled = true;
      publishEdit(ev, body, title ? title.value.replace(/\s+/g, ' ').trim() : null)
        .then(function () { form.remove(); }, function () { save.disabled = false; });
    });
    container.appendChild(form);
    (title || area).focus();
  }

  function publishEdit(ev, body, title) {
    var tags = ev.tags.filter(function (t) { return t[0] !== 'edit' && t[0] !== 'title'; });
    if (title) tags.unshift(['title', title.slice(0, TITLE_MAX)]);
    tags.push(['edit', ev.id]);
    return auth.signEvent({ kind: ev.kind, created_at: Math.floor(Date.now() / 1000), tags: tags, content: body.slice(0, BODY_MAX) })
      .then(function (signed) {
        if (!NT.verifyEvent(signed)) throw new Error('Signature check failed');
        if (signed.kind === THREAD_KIND) threads.set(signed.id, signed);
        else comments.set(signed.id, signed);
        noteEdit(signed);
        queueRender();
        return net.publish(signed);
      });
  }

  // NIP-09: ask the relays to drop it. Copies elsewhere may survive, which the
  // confirmation says.
  function remove(ev) {
    return auth.signEvent({
      kind: 5,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['e', ev.id], ['k', String(ev.kind)]],
      content: 'deleted by the author'
    }).then(function (signed) {
      deleted.add(ev.id);
      var replacement = edits.get(ev.id);
      if (replacement) deleted.add(replacement.id);
      queueRender();
      if (route.view === 'thread' && route.id === ev.id) go('#/c/' + (threadCategory(ev) || ''));
      return net.publish(signed);
    });
  }

  // NIP-25 reaction: '+' is an upvote, and taking it back deletes the reaction.
  function toggleVote(ev) {
    if (!auth.pubkey) { location.href = '/login?next=/forum'; return; }
    var existing = myVote(ev.id);
    if (existing) {
      var map = votes.get(ev.id);
      map.delete(auth.pubkey);
      queueRender();
      return auth.signEvent({ kind: 5, created_at: Math.floor(Date.now() / 1000), tags: [['e', existing], ['k', '7']], content: 'vote removed' })
        .then(function (signed) { deleted.add(existing); return net.publish(signed); });
    }
    return auth.signEvent({
      kind: 7,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['e', ev.id], ['p', ev.pubkey], ['k', String(ev.kind)]],
      content: '+'
    }).then(function (signed) {
      addReaction(signed);
      queueRender();
      return net.publish(signed);
    });
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
    applyPendingDeletes(ev);
    if (noteEdit(ev)) { queueRender(); return; }
    net.requestProfile(ev.pubkey);
    scheduleCounts();
    queueRender();
  }

  function addReaction(ev) {
    if (ev.kind !== 7 || deleted.has(ev.id)) return;
    if (['+', '', '\u2764', '\ud83d\udc4d'].indexOf(ev.content) === -1) return;
    var target = ev.tags.filter(function (t) { return t[0] === 'e'; }).pop();
    if (!target) return;
    var map = votes.get(target[1]);
    if (!map) { map = new Map(); votes.set(target[1], map); }
    map.set(ev.pubkey, ev.id);
    queueRender();
  }

  // A deletion only counts when it comes from the author of the target event.
  var pendingDeletes = new Map();   // target id -> pubkey that asked
  function addDeletion(ev) {
    if (ev.kind !== 5) return;
    ev.tags.forEach(function (t) {
      if (t[0] !== 'e') return;
      var target = threads.get(t[1]) || comments.get(t[1]);
      if (target) {
        if (target.pubkey === ev.pubkey) { deleted.add(t[1]); queueRender(); }
        return;
      }
      pendingDeletes.set(t[1], ev.pubkey);
      // reactions are only known by id, so drop ours if its author asked
      votes.forEach(function (map, id) {
        map.forEach(function (reactionId, pubkey) {
          if (reactionId === t[1] && pubkey === ev.pubkey) { map.delete(pubkey); queueRender(); }
        });
      });
    });
  }

  function applyPendingDeletes(ev) {
    var asked = pendingDeletes.get(ev.id);
    if (asked && asked === ev.pubkey) deleted.add(ev.id);
  }

  function addComment(ev) {
    if (ev.kind === 7) return addReaction(ev);
    if (ev.kind === 5) return addDeletion(ev);
    if (comments.has(ev.id) || ev.kind !== COMMENT_KIND) return;
    comments.set(ev.id, ev);
    applyPendingDeletes(ev);
    if (noteEdit(ev)) { queueRender(); return; }
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
        var chunk = ids.slice(i, i + 50);
        pool.subscribeManyEose(RELAYS, { kinds: [COMMENT_KIND], '#E': chunk }, {
          onevent: addComment,
          onclose: function () { queueRender(); }
        });
        // votes on the threads themselves, and deletions of any of them
        pool.subscribeMany(RELAYS, { kinds: [7, 5], '#e': chunk }, { onevent: addComment });
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
    // edits and deletions of the thread and of anything in it
    pool.subscribeMany(RELAYS, { kinds: [7, 5], '#e': [id], limit: 300 }, { onevent: addComment });
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
    var threadClosed = route.view === 'thread' && route.id && mod.isClosed(route.id);
    if (els.newToggle) els.newToggle.hidden = !loggedIn;
    if (els.newLocked) els.newLocked.hidden = loggedIn;
    if (els.newForm && !loggedIn) els.newForm.hidden = true;
    if (els.replyForm) els.replyForm.hidden = !loggedIn || threadClosed;
    if (els.replyLocked) {
      els.replyLocked.hidden = loggedIn && !threadClosed;
      if (threadClosed) els.replyLocked.textContent = 'This thread is closed. You can read it, but not answer.';
      else if (!loggedIn) {
        els.replyLocked.textContent = '';
        var link = document.createElement('a');
        link.className = 'text-btn';
        link.href = '/login?next=/forum';
        link.textContent = 'Log in';
        els.replyLocked.append(link, document.createTextNode(' to reply.'));
      }
    }
  }

  function onLoginChange() {
    updateComposerVisibility();
    queueRender();
  }

  function showError(el, msg) {
    if (!el) return;
    el.textContent = msg;
    clearTimeout(el._t);
    el._t = setTimeout(function () { el.textContent = ''; }, 6000);
  }

  function wire() {
    window.addEventListener('hashchange', applyRoute);
    if (els.newBody) els.newForm.insertBefore(pictureButton(els.newBody), els.newForm.querySelector('button[type=submit]'));
    if (els.replyBody) els.replyForm.insertBefore(pictureButton(els.replyBody), els.replyForm.querySelector('button[type=submit]'));
    mod.onChange(function () { updateComposerVisibility(); queueRender(); });

    if (els.sortRecent) els.sortRecent.addEventListener('click', function () { sortBy = 'recent'; render(); });
    if (els.sortTop) els.sortTop.addEventListener('click', function () { sortBy = 'top'; render(); });

    els.newToggle.addEventListener('click', function () {
      els.newForm.hidden = !els.newForm.hidden;
      if (!els.newForm.hidden) els.newTitle.focus();
    });

    els.newForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var title = els.newTitle.value.replace(/\s+/g, ' ').trim();
      var body = els.newBody.value.trim();
      if (title.length < 4) return showError(els.newError, 'Give the thread a title of at least 4 characters.');
      if (!body) return showError(els.newError, 'Write something in the body.');
      var btn = els.newForm.querySelector('button[type=submit]');
      btn.disabled = true;
      postThread(title.slice(0, TITLE_MAX), body.slice(0, BODY_MAX), route.slug)
        .then(function () { els.newForm.reset(); els.newForm.hidden = true; })
        .catch(function (err) { showError(els.newError, err.message || 'Could not post the thread.'); })
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

    document.addEventListener('semrede-login', onLoginChange);
    document.addEventListener('semrede-logout', onLoginChange);
    auth.ready.then(onLoginChange);
    net.onProfile(function () { queueRender(); });
    net.onMuteChange(function () { queueRender(); });
  }

  wire();
  applyRoute();
  mod.watch();
  watchForum();
  net.relayStatus(els.relayDots, els.relayCount);
})();
