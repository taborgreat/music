(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const els = {
    count: $('#count'),
    search: $('#search'),
    view: $('#view'),
    markedCount: $('#marked-count'),
    sort: $('#sort'),
    random: $('#random'),
    rescan: $('#rescan'),
    admin: $('#admin'),
    tree: $('#tree'),
    list: $('#list'),
    prev: $('#prev'),
    next: $('#next'),
    npTitle: $('#np-title'),
    npSub: $('#np-sub'),
    pMark: $('#p-mark'),
    pPrev: $('#p-prev'),
    pPlay: $('#p-play'),
    pNext: $('#p-next'),
    pRandom: $('#p-random'),
    pShuffle: $('#p-shuffle'),
    audio: $('#audio'),
    comments: document.querySelector('.comments'),
    cToggle: $('#c-toggle'),
    cTitle: $('#c-title'),
    cChev: $('#c-chev'),
    cList: $('#c-list'),
    cForm: $('#c-form'),
    cName: $('#c-name'),
    cWebsite: $('#c-website'),
    cText: $('#c-text'),
    cPost: $('#c-post'),
    cStatus: $('#c-status'),
    toast: $('#toast'),
  };

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  // ---- per-browser preferences ----

  const PREFS_KEY = 'songs.prefs';
  let prefs = {};
  try {
    prefs = JSON.parse(localStorage.getItem(PREFS_KEY)) || {};
  } catch {
    prefs = {};
  }
  function savePref(key, value) {
    prefs[key] = value;
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
      /* private mode etc. */
    }
  }

  const state = {
    songs: [],
    byId: new Map(),
    meta: {},
    me: { adminRequired: false, isAdmin: true },
    q: '',
    view: prefs.view === 'marked' ? 'marked' : 'all',
    sort: ['newest', 'oldest', 'name'].includes(prefs.sort) ? prefs.sort : 'newest',
    year: null,
    month: null,
    filtered: [],
    currentId: null,
    shuffle: !!prefs.shuffle,
    duration: 0,
    commentsOpen: prefs.commentsOpen !== false,
  };

  // ---- helpers ----

  const pad = (n) => String(n).padStart(2, '0');
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);
  const firstLine = (s) => s.split('\n').find((l) => l.trim()) || '';
  const fmtSize = (b) => (b >= 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.round(b / 1e3) + ' KB');
  const fmtTime = (sec) => (Number.isFinite(sec) ? `${Math.floor(sec / 60)}:${pad(Math.floor(sec % 60))}` : '');
  const metaOf = (id) => state.meta[id] || {};
  const commentsOf = (id) => metaOf(id).comments || [];
  const current = () => state.byId.get(state.currentId) || null;
  const rowFor = (id) => (id == null ? null : els.list.querySelector(`.row[data-id="${CSS.escape(id)}"]`));
  const canMark = () => !state.me.adminRequired || state.me.isAdmin;

  function timeAgo(ms) {
    const s = Math.max(0, (Date.now() - ms) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    if (s < 86400 * 14) return `${Math.floor(s / 86400)}d ago`;
    const d = new Date(ms);
    return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
  }

  let toastTimer = null;
  function toast(msg) {
    els.toast.textContent = msg;
    els.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      els.toast.hidden = true;
    }, 3000);
  }

  function decorate(s) {
    const d = new Date(s.created);
    const y = d.getFullYear();
    const m = d.getMonth();
    const day = d.getDate();
    const dateLabel = `${MONTHS[m]} ${day}, ${y}`;
    const search = [
      s.name,
      s.ext,
      dateLabel,
      MONTHS_LONG[m],
      `${y}-${pad(m + 1)}-${pad(day)}`,
      `${m + 1}/${day}/${y}`,
      `${m + 1}-${day}-${y}`,
    ]
      .join(' ')
      .toLowerCase();
    return { ...s, y, m, dateLabel, search };
  }

  // ---- api ----

  function headers(json) {
    const h = {};
    if (json) h['Content-Type'] = 'application/json';
    if (prefs.adminKey) h['X-Admin-Key'] = prefs.adminKey;
    return h;
  }

  async function api(method, url, body) {
    const r = await fetch(url, { method, headers: headers(body !== undefined), body: body === undefined ? undefined : JSON.stringify(body) });
    let data = null;
    try {
      data = await r.json();
    } catch {
      /* no body */
    }
    if (!r.ok) throw new Error((data && data.error) || `HTTP ${r.status}`);
    return data;
  }

  async function loadAll(rescan) {
    const [lib, meta, me] = await Promise.all([
      api('GET', '/api/songs' + (rescan ? '?rescan=1' : '')),
      api('GET', '/api/meta'),
      api('GET', '/api/me'),
    ]);
    state.meta = meta && typeof meta === 'object' ? meta : {};
    state.me = me || state.me;
    state.songs = (lib.songs || []).map(decorate);
    state.byId = new Map(state.songs.map((s) => [s.id, s]));
    els.admin.hidden = !state.me.adminRequired;
    els.admin.classList.toggle('on', state.me.isAdmin);
    render();
    updatePlayer();
  }

  function applyMeta(id, entry) {
    if (entry && (entry.marked || (entry.comments && entry.comments.length))) state.meta[id] = entry;
    else delete state.meta[id];
    refreshRow(id);
    if (id === state.currentId) updatePlayer();
    updateMarkedCount();
    if (state.view === 'marked' && !(entry && entry.marked)) render();
  }

  async function setMarked(id, marked) {
    const prev = state.meta[id];
    applyMeta(id, { ...(prev || {}), marked });
    try {
      const data = await api('PUT', '/api/meta/' + encodeURIComponent(id), { marked });
      applyMeta(id, data.meta);
    } catch (err) {
      applyMeta(id, prev);
      toast('Could not save: ' + err.message);
    }
  }

  function toggleMark(id) {
    if (!id) return;
    if (!canMark()) {
      toast('Marking songs needs the admin key (🔑 in the header)');
      return;
    }
    setMarked(id, !metaOf(id).marked);
  }

  function updateMarkedCount() {
    let n = 0;
    for (const id in state.meta) if (state.meta[id].marked && state.byId.has(id)) n++;
    els.markedCount.textContent = n ? String(n) : '';
  }

  // ---- rendering ----

  // Songs matching the view (all / marked) and the search text.
  // Year and month are applied afterwards so the tree can show counts.
  function baseList() {
    const terms = state.q.toLowerCase().split(/\s+/).filter(Boolean);
    return state.songs.filter((s) => {
      const m = state.meta[s.id];
      if (state.view === 'marked' && !(m && m.marked)) return false;
      if (terms.length) {
        let hay = s.search;
        if (m && m.comments) hay += ' ' + m.comments.map((c) => c.name + ' ' + c.text).join(' ').toLowerCase();
        for (const t of terms) if (!hay.includes(t)) return false;
      }
      return true;
    });
  }

  function sortList(list) {
    if (state.sort === 'oldest') list.sort((a, b) => a.created - b.created || a.name.localeCompare(b.name));
    else if (state.sort === 'name') list.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    else list.sort((a, b) => b.created - a.created || a.name.localeCompare(b.name));
    return list;
  }

  function render() {
    const base = baseList();
    renderTree(base);
    let list = base;
    if (state.year != null) list = list.filter((s) => s.y === state.year && (state.month == null || s.m === state.month));
    state.filtered = sortList(list);
    renderList();
    els.count.textContent =
      state.filtered.length === state.songs.length ? `${state.songs.length}` : `${state.filtered.length} of ${state.songs.length}`;
    for (const b of els.view.querySelectorAll('button')) b.classList.toggle('on', b.dataset.view === state.view);
    updateMarkedCount();
  }

  function renderTree(base) {
    const years = new Map();
    for (const s of base) {
      let yr = years.get(s.y);
      if (!yr) years.set(s.y, (yr = { count: 0, months: new Map() }));
      yr.count++;
      yr.months.set(s.m, (yr.months.get(s.m) || 0) + 1);
    }
    // Keep the selected year/month visible even if nothing matches right now.
    if (state.year != null && !years.has(state.year)) years.set(state.year, { count: 0, months: new Map() });
    if (state.year != null && state.month != null && !years.get(state.year).months.has(state.month)) {
      years.get(state.year).months.set(state.month, 0);
    }

    const desc = state.sort !== 'oldest';
    const ys = [...years.keys()].sort((a, b) => (desc ? b - a : a - b));
    let html = `<button type="button" class="all${state.year == null ? ' on' : ''}" data-all><span>All years</span><span class="n">${base.length}</span></button>`;
    for (const y of ys) {
      const yr = years.get(y);
      const open = state.year === y;
      html += `<div class="yr-group"><button type="button" class="yr${open ? ' on' : ''}" data-year="${y}"><span>${y}</span><span class="n">${yr.count}</span></button>`;
      if (open) {
        const ms = [...yr.months.keys()].sort((a, b) => (desc ? b - a : a - b));
        html += '<div class="months">';
        for (const m of ms) {
          html += `<button type="button" class="mo${state.month === m ? ' on' : ''}" data-month="${m}"><span>${MONTHS[m]}</span><span class="n">${yr.months.get(m)}</span></button>`;
        }
        html += '</div>';
      }
      html += '</div>';
    }
    els.tree.innerHTML = html;
  }

  function previewText(id) {
    const cs = commentsOf(id);
    if (!cs.length) return '';
    const last = cs[cs.length - 1];
    return `💬 ${cs.length} · ${last.name}: ${firstLine(last.text)}`;
  }

  function rowHtml(s) {
    const m = metaOf(s.id);
    const cls = 'row' + (m.marked ? ' marked' : '') + (s.id === state.currentId ? ' on' : '');
    const preview = previewText(s.id);
    const note = preview ? `<div class="note-preview">${esc(preview)}</div>` : '';
    return (
      `<div class="${cls}" data-id="${esc(s.id)}">` +
      `<button type="button" class="star" data-act="mark" title="Mark / unmark">${m.marked ? '★' : '☆'}</button>` +
      `<div class="main"><div class="name">${esc(s.name)}<span class="ext">${esc(s.ext)}</span></div>${note}</div>` +
      `<div class="date">${s.dateLabel}</div>` +
      `</div>`
    );
  }

  function renderList() {
    if (!state.filtered.length) {
      els.list.innerHTML = `<div class="empty">${state.songs.length ? 'No songs match.' : 'No audio files found in the songs folder.'}</div>`;
      return;
    }
    els.list.innerHTML = state.filtered.map(rowHtml).join('');
    const row = rowFor(state.currentId);
    if (row) row.scrollIntoView({ block: 'nearest' });
  }

  function refreshRow(id) {
    const row = rowFor(id);
    if (!row) return;
    const m = metaOf(id);
    row.classList.toggle('marked', !!m.marked);
    row.querySelector('.star').textContent = m.marked ? '★' : '☆';
    let np = row.querySelector('.note-preview');
    const preview = previewText(id);
    if (preview) {
      if (!np) {
        np = document.createElement('div');
        np.className = 'note-preview';
        row.querySelector('.main').appendChild(np);
      }
      np.textContent = preview;
    } else if (np) {
      np.remove();
    }
  }

  function highlightRow() {
    for (const r of els.list.querySelectorAll('.row.on')) if (r.dataset.id !== state.currentId) r.classList.remove('on');
    const row = rowFor(state.currentId);
    if (row) {
      row.classList.add('on');
      row.scrollIntoView({ block: 'nearest' });
    }
  }

  // ---- player ----

  function play(id, { autoplay = true } = {}) {
    const s = state.byId.get(id);
    if (!s) return;
    if (state.currentId !== id || !els.audio.getAttribute('src')) {
      state.currentId = id;
      state.duration = 0;
      els.audio.src = '/audio/' + encodeURIComponent(id);
      savePref('lastId', id);
    }
    if (autoplay) {
      const p = els.audio.play();
      if (p && p.catch) p.catch(() => {});
    }
    updatePlayer();
    highlightRow();
  }

  // Move within the list as it is currently shown (filters + sort applied).
  function step(dir) {
    const list = state.filtered;
    if (!list.length) return;
    const i = list.findIndex((s) => s.id === state.currentId);
    let n;
    if (i === -1) n = dir > 0 ? 0 : list.length - 1;
    else n = (i + dir + list.length) % list.length;
    play(list[n].id);
  }

  // Random draws from every year no matter which year/month tab is open.
  // Search text and the Marked view still apply. If the pick is outside the
  // open tab, the tab is cleared so the list shows where the song is.
  function random() {
    let pool = baseList();
    if (!pool.length) pool = state.songs;
    if (!pool.length) return;
    let pick = pool[Math.floor(Math.random() * pool.length)];
    if (pool.length > 1 && pick.id === state.currentId) pick = pool[(pool.indexOf(pick) + 1) % pool.length];
    if (state.year != null && !state.filtered.includes(pick)) {
      state.year = null;
      state.month = null;
      render();
    }
    play(pick.id);
  }

  function togglePlay() {
    if (!current()) {
      random();
      return;
    }
    if (els.audio.paused) {
      const p = els.audio.play();
      if (p && p.catch) p.catch(() => {});
    } else {
      els.audio.pause();
    }
  }

  function updatePlayer() {
    const s = current();
    const playing = !els.audio.paused && !els.audio.ended;
    els.pPlay.textContent = playing ? '❚❚' : '▶';
    els.pShuffle.classList.toggle('on', state.shuffle);
    els.comments.classList.toggle('closed', !state.commentsOpen);
    els.cChev.textContent = state.commentsOpen ? '▾' : '▸';
    if (!s) {
      els.npTitle.textContent = 'Nothing playing';
      els.npSub.textContent = 'Pick a song, or hit Random';
      els.pMark.textContent = '☆';
      els.pMark.classList.remove('on');
      els.cTitle.textContent = 'Comments';
      els.cList.innerHTML = '';
      els.cText.disabled = true;
      els.cPost.disabled = true;
      document.title = 'songs';
      return;
    }
    const m = metaOf(s.id);
    els.npTitle.textContent = s.name;
    const parts = [s.dateLabel, s.ext.toUpperCase(), fmtSize(s.size)];
    if (state.duration) parts.push(fmtTime(state.duration));
    els.npSub.textContent = parts.join(' · ');
    els.pMark.textContent = m.marked ? '★' : '☆';
    els.pMark.classList.toggle('on', !!m.marked);
    els.cText.disabled = false;
    els.cPost.disabled = false;
    renderComments();
    document.title = (playing ? '▶ ' : '') + s.name + ' · songs';
  }

  // ---- comments ----

  function renderComments() {
    const id = state.currentId;
    const cs = commentsOf(id);
    els.cTitle.textContent = cs.length ? `${cs.length} comment${cs.length === 1 ? '' : 's'}` : 'Comments';
    const admin = state.me.isAdmin && state.me.adminRequired;
    els.cList.innerHTML = cs
      .map(
        (c) =>
          `<div class="comment" data-cid="${esc(c.id)}">` +
          `<div class="who"><b>${esc(c.name)}</b> · ${timeAgo(c.at)}${c.ip ? ' · ' + esc(c.ip) : ''}</div>` +
          (admin ? `<button type="button" class="del" data-act="del" title="Delete comment">×</button>` : '<span></span>') +
          `<div class="text">${esc(c.text)}</div>` +
          `</div>`
      )
      .join('');
    els.cList.scrollTop = els.cList.scrollHeight;
  }

  function setStatus(msg, isError) {
    els.cStatus.textContent = msg || '';
    els.cStatus.classList.toggle('err', !!isError);
  }

  let posting = false;
  async function postComment() {
    const id = state.currentId;
    const text = els.cText.value.trim();
    if (!id || !text || posting) return;
    posting = true;
    els.cPost.disabled = true;
    setStatus('posting…');
    try {
      const data = await api('POST', '/api/comments/' + encodeURIComponent(id), {
        name: els.cName.value.trim(),
        text,
        website: els.cWebsite.value,
      });
      savePref('name', els.cName.value.trim());
      const entry = { ...metaOf(id), comments: [...commentsOf(id), data.comment] };
      applyMeta(id, entry);
      els.cText.value = '';
      setStatus('');
    } catch (err) {
      setStatus(err.message, true);
    } finally {
      posting = false;
      els.cPost.disabled = !state.currentId;
    }
  }

  async function deleteComment(id, cid) {
    try {
      const data = await api('DELETE', `/api/comments/${encodeURIComponent(id)}/${encodeURIComponent(cid)}`);
      applyMeta(id, data.meta);
    } catch (err) {
      toast('Could not delete: ' + err.message);
    }
  }

  async function enterAdminKey() {
    const key = window.prompt('Admin key', prefs.adminKey || '');
    if (key === null) return;
    savePref('adminKey', key.trim());
    try {
      state.me = await api('GET', '/api/me');
      state.meta = await api('GET', '/api/meta');
    } catch (err) {
      toast(err.message);
      return;
    }
    els.admin.classList.toggle('on', state.me.isAdmin);
    toast(state.me.isAdmin ? 'Admin mode on' : 'Wrong key');
    render();
    updatePlayer();
  }

  // ---- events ----

  let searchTimer = null;
  els.search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.q = els.search.value;
      render();
    }, 120);
  });

  els.view.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-view]');
    if (!b) return;
    state.view = b.dataset.view;
    savePref('view', state.view);
    render();
  });

  els.sort.addEventListener('change', () => {
    state.sort = els.sort.value;
    savePref('sort', state.sort);
    render();
  });

  els.tree.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.hasAttribute('data-all')) {
      state.year = null;
      state.month = null;
    } else if ('year' in b.dataset) {
      const y = Number(b.dataset.year);
      state.year = state.year === y ? null : y;
      state.month = null;
    } else if ('month' in b.dataset) {
      const m = Number(b.dataset.month);
      state.month = state.month === m ? null : m;
    }
    render();
  });

  els.list.addEventListener('click', (e) => {
    const row = e.target.closest('.row');
    if (!row) return;
    if (e.target.closest('[data-act="mark"]')) toggleMark(row.dataset.id);
    else play(row.dataset.id);
  });

  els.random.addEventListener('click', random);
  els.pRandom.addEventListener('click', random);
  els.prev.addEventListener('click', () => step(-1));
  els.pPrev.addEventListener('click', () => step(-1));
  els.next.addEventListener('click', () => step(1));
  els.pNext.addEventListener('click', () => step(1));
  els.pPlay.addEventListener('click', togglePlay);
  els.pMark.addEventListener('click', () => toggleMark(state.currentId));
  els.pShuffle.addEventListener('click', () => {
    state.shuffle = !state.shuffle;
    savePref('shuffle', state.shuffle);
    updatePlayer();
  });
  els.admin.addEventListener('click', enterAdminKey);

  els.rescan.addEventListener('click', async () => {
    els.rescan.disabled = true;
    try {
      await loadAll(true);
      toast(`Rescanned: ${state.songs.length} songs`);
    } catch (err) {
      toast('Rescan failed: ' + err.message);
    } finally {
      els.rescan.disabled = false;
    }
  });

  els.cToggle.addEventListener('click', () => {
    state.commentsOpen = !state.commentsOpen;
    savePref('commentsOpen', state.commentsOpen);
    updatePlayer();
  });
  els.cForm.addEventListener('submit', (e) => {
    e.preventDefault();
    postComment();
  });
  els.cText.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      postComment();
    }
  });
  els.cText.addEventListener('input', () => setStatus(''));
  els.cList.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act="del"]');
    if (!b) return;
    const c = b.closest('.comment');
    if (c && state.currentId) deleteComment(state.currentId, c.dataset.cid);
  });

  els.audio.addEventListener('play', updatePlayer);
  els.audio.addEventListener('pause', updatePlayer);
  els.audio.addEventListener('ended', () => (state.shuffle ? random() : step(1)));
  els.audio.addEventListener('loadedmetadata', () => {
    state.duration = els.audio.duration;
    updatePlayer();
  });
  els.audio.addEventListener('error', () => {
    const s = current();
    if (s && els.audio.getAttribute('src')) toast(`Can't play "${s.name}"`);
  });
  els.audio.addEventListener('volumechange', () => {
    savePref('volume', els.audio.volume);
    savePref('muted', els.audio.muted);
  });

  document.addEventListener('keydown', (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const t = e.target;
    const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
    if (typing) {
      if (e.key === 'Escape') t.blur();
      return;
    }
    switch (e.key) {
      case 'ArrowLeft':
        e.preventDefault();
        step(-1);
        break;
      case 'ArrowRight':
        e.preventDefault();
        step(1);
        break;
      case ' ':
        e.preventDefault();
        togglePlay();
        break;
      case 'r':
      case 'R':
        random();
        break;
      case 'm':
      case 'M':
        toggleMark(state.currentId);
        break;
      case '/':
        e.preventDefault();
        els.search.focus();
        els.search.select();
        break;
      default:
        break;
    }
  });

  // ---- start ----

  async function init() {
    els.sort.value = state.sort;
    els.cName.value = prefs.name || '';
    if (typeof prefs.volume === 'number') els.audio.volume = Math.min(1, Math.max(0, prefs.volume));
    if (prefs.muted) els.audio.muted = true;
    updatePlayer();
    try {
      await loadAll(false);
    } catch (err) {
      els.list.innerHTML = `<div class="empty">Could not load songs: ${esc(err.message)}</div>`;
      return;
    }
    if (prefs.lastId && state.byId.has(prefs.lastId)) {
      play(prefs.lastId, { autoplay: false });
      const row = rowFor(prefs.lastId);
      if (row) row.scrollIntoView({ block: 'center' });
    }
  }

  init();
})();
