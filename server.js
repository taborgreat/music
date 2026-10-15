'use strict';

// Zero-dependency web player for a folder of audio files, with public comments.
//   SONGS_DIR    folder to scan (default: D:\o, top level only)
//   PORT         default 3000
//   HOST         default 0.0.0.0 (reachable from other devices / a tunnel)
//   ADMIN_KEY    if set, marking songs and deleting comments need this key
//                (sent as the X-Admin-Key header). Unset = anyone can.
//   TRUST_PROXY  set to 1 when behind a reverse proxy / tunnel so the real
//                client IP is read from X-Forwarded-For.
// Marks and comments are stored in data.json next to this file.

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// Optional .env next to this file: KEY=VALUE lines, # comments. Real env vars win.
try {
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
} catch {
  /* no .env */
}

const SONGS_DIR = path.resolve(process.env.SONGS_DIR || 'D:\\o');
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const DATA_FILE = path.join(__dirname, 'data.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const SCAN_TTL_MS = 30 * 1000;
const HARD_BODY_LIMIT = 256 * 1024; // beyond this the connection is dropped, not drained

const LIMITS = {
  // comments
  textMax: 600,
  nameMax: 32,
  maxLinks: 2,
  commentMinGapMs: 2000, // same IP: at least 2s between posts (kills double posts)
  perIpPerMinute: 6,
  perIpPerHour: 40,
  perIpPerDay: 150,
  perIpPerSongPer10Min: 5,
  globalPerMinute: 60,
  dupSameIpMs: 24 * 3600e3, // same text from the same IP within a day
  dupSameSongMs: 10 * 60e3, // same text on the same song from anyone within 10 min
  maxCommentsPerSong: 300,
  maxCommentsTotal: 20000,
  // everything else
  apiPerMinute: 120,
  audioPerMinute: 600,
  adminFailsPer10Min: 10,
  rescanMinGapMs: 15000,
};

const AUDIO_TYPES = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.webm': 'audio/webm',
};

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

// ---------------------------------------------------------------------------
// Library: the audio files found in SONGS_DIR (top level only).
// ---------------------------------------------------------------------------

let library = { songs: [], scannedAt: 0 };
let scanInFlight = null;
let lastForcedScan = 0;

function createdTime(st) {
  // Earliest of birth time and modified time. A copied file gets a fresh
  // birth time but keeps its original mtime, so the minimum is the best
  // guess at when the song was actually made.
  const times = [st.birthtimeMs, st.mtimeMs].filter((t) => Number.isFinite(t) && t > 0);
  return times.length ? Math.round(Math.min(...times)) : Date.now();
}

function scan() {
  if (scanInFlight) return scanInFlight;
  scanInFlight = (async () => {
    const entries = await fsp.readdir(SONGS_DIR, { withFileTypes: true });
    const songs = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!AUDIO_TYPES[ext]) continue;
      let st;
      try {
        st = await fsp.stat(path.join(SONGS_DIR, entry.name));
      } catch {
        continue;
      }
      songs.push({
        id: entry.name,
        name: entry.name.slice(0, -ext.length),
        ext: ext.slice(1),
        size: st.size,
        created: createdTime(st),
        modified: Math.round(st.mtimeMs),
      });
    }
    songs.sort((a, b) => b.created - a.created || a.name.localeCompare(b.name));
    library = { songs, scannedAt: Date.now() };
    return library;
  })().finally(() => {
    scanInFlight = null;
  });
  return scanInFlight;
}

async function getLibrary(force) {
  const now = Date.now();
  const forced = force && now - lastForcedScan > LIMITS.rescanMinGapMs;
  if (forced) lastForcedScan = now;
  if (forced || now - library.scannedAt > SCAN_TTL_MS) await scan();
  return library;
}

// ---------------------------------------------------------------------------
// Meta: marks and comments, keyed by file name, persisted to data.json.
//   { "<file>": { marked, markedAt, comments: [{ id, name, text, at, ip }] } }
// ---------------------------------------------------------------------------

let meta = {};
try {
  const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) meta = parsed;
} catch (err) {
  if (err.code !== 'ENOENT') console.error(`Could not read ${DATA_FILE}: ${err.message}`);
}
let totalComments = 0;
for (const entry of Object.values(meta)) totalComments += (entry.comments || []).length;

let saveQueue = Promise.resolve();
function saveMeta() {
  saveQueue = saveQueue
    .then(async () => {
      const tmp = DATA_FILE + '.tmp';
      await fsp.writeFile(tmp, JSON.stringify(meta, null, 2) + '\n');
      await fsp.rename(tmp, DATA_FILE);
    })
    .catch((err) => console.error(`Could not save ${DATA_FILE}: ${err.message}`));
  return saveQueue;
}

function tidyEntry(id) {
  const entry = meta[id];
  if (!entry) return;
  if (!entry.marked) {
    delete entry.marked;
    delete entry.markedAt;
  }
  if (entry.comments && !entry.comments.length) delete entry.comments;
  if (!Object.keys(entry).length) delete meta[id];
}

const publicComment = (c, admin) => (admin ? { id: c.id, name: c.name, text: c.text, at: c.at, ip: c.ip } : { id: c.id, name: c.name, text: c.text, at: c.at });

function publicEntry(entry, admin) {
  if (!entry) return null;
  const out = {};
  if (entry.marked) {
    out.marked = true;
    out.markedAt = entry.markedAt;
  }
  if (entry.comments && entry.comments.length) out.comments = entry.comments.map((c) => publicComment(c, admin));
  return Object.keys(out).length ? out : null;
}

function publicMeta(admin) {
  const out = {};
  for (const [id, entry] of Object.entries(meta)) {
    const e = publicEntry(entry, admin);
    if (e) out[id] = e;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rate limiting (in memory, sliding windows keyed by IP)
// ---------------------------------------------------------------------------

const RETAIN_MS = 24 * 3600e3;
const windows = new Map(); // key -> sorted timestamps within the last 24h

function stamps(key) {
  const arr = windows.get(key);
  if (!arr) return [];
  const cutoff = Date.now() - RETAIN_MS;
  let i = 0;
  while (i < arr.length && arr[i] <= cutoff) i++;
  if (i) arr.splice(0, i);
  return arr;
}
function countSince(key, ms) {
  const arr = stamps(key);
  const t = Date.now() - ms;
  let n = 0;
  for (let i = arr.length - 1; i >= 0 && arr[i] > t; i--) n++;
  return n;
}
function lastStamp(key) {
  const arr = stamps(key);
  return arr.length ? arr[arr.length - 1] : 0;
}
function record(key) {
  let arr = windows.get(key);
  if (!arr) windows.set(key, (arr = []));
  arr.push(Date.now());
}
// Check-and-record in one go for simple per-minute limits.
function tooMany(key, max, windowMs) {
  if (countSince(key, windowMs) >= max) return true;
  record(key);
  return false;
}

const recentPosts = []; // { ip, song, norm, at } for duplicate detection
function pruneRecentPosts() {
  const cutoff = Date.now() - LIMITS.dupSameIpMs;
  while (recentPosts.length && recentPosts[0].at < cutoff) recentPosts.shift();
}

setInterval(() => {
  for (const key of windows.keys()) if (!stamps(key).length) windows.delete(key);
  pruneRecentPosts();
}, 10 * 60e3).unref();

const IP_SALT = crypto.createHash('sha256').update(`songs-ip-salt:${os.hostname()}:${ADMIN_KEY}`).digest();
const ipHash = (ip) => crypto.createHmac('sha256', IP_SALT).update(ip).digest('hex').slice(0, 12);

function clientIp(req) {
  if (TRUST_PROXY) {
    const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (fwd) return fwd;
  }
  const ip = req.socket.remoteAddress || '';
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

function isAdmin(req, ip) {
  if (!ADMIN_KEY) return true;
  const given = String(req.headers['x-admin-key'] || '');
  if (!given) return false;
  if (countSince('adm:' + ip, 10 * 60e3) >= LIMITS.adminFailsPer10Min) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(ADMIN_KEY);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!ok) record('adm:' + ip);
  return ok;
}

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL_CHARS, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max);
}

const normalize = (text) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

function rejectReason(ip, songId, text) {
  const now = Date.now();
  if ((text.match(/https?:\/\/|www\./gi) || []).length > LIMITS.maxLinks) return [400, 'Too many links.'];
  if (/(.)\1{29,}/su.test(text)) return [400, 'That looks like spam.'];
  if (normalize(text).length === 0) return [400, 'Write something first.'];

  const ipKey = 'c:' + ip;
  if (now - lastStamp(ipKey) < LIMITS.commentMinGapMs) return [429, 'Slow down a little.'];
  if (
    countSince(ipKey, 60e3) >= LIMITS.perIpPerMinute ||
    countSince(ipKey, 3600e3) >= LIMITS.perIpPerHour ||
    countSince(ipKey, 86400e3) >= LIMITS.perIpPerDay
  ) {
    return [429, 'You have posted a lot. Try again later.'];
  }
  if (countSince(`cs:${ip}|${songId}`, 10 * 60e3) >= LIMITS.perIpPerSongPer10Min) return [429, 'Too many comments on this song. Try again in a few minutes.'];
  if (countSince('c:*', 60e3) >= LIMITS.globalPerMinute) return [429, 'The site is busy. Try again in a minute.'];

  pruneRecentPosts();
  const norm = normalize(text);
  for (const p of recentPosts) {
    if (p.norm !== norm) continue;
    if (p.ip === ip && now - p.at < LIMITS.dupSameIpMs) return [409, 'You already posted that.'];
    if (p.song === songId && now - p.at < LIMITS.dupSameSongMs) return [409, 'Someone just posted exactly that.'];
  }

  const existing = (meta[songId] && meta[songId].comments) || [];
  if (existing.length >= LIMITS.maxCommentsPerSong) return [429, 'This song has enough comments.'];
  if (totalComments >= LIMITS.maxCommentsTotal) return [429, 'The comment box is full.'];
  return null;
}

async function postComment(req, res, song, ip) {
  const body = await readJson(req, 8 * 1024);
  const text = cleanText(body.text, LIMITS.textMax);
  const name = cleanText(body.name, LIMITS.nameMax).replace(/\s+/g, ' ') || 'anon';

  // Honeypot: real users never see this field. Pretend it worked, store nothing.
  if (typeof body.website === 'string' && body.website.trim()) {
    console.log(`[comment] honeypot hit from ${ip}`);
    return send(res, 201, { comment: { id: 'x', name, text, at: Date.now() } });
  }
  if (!text) return send(res, 400, { error: 'Write something first.' });

  const reason = rejectReason(ip, song.id, text);
  if (reason) {
    console.log(`[comment] blocked ${ip} on "${song.id}": ${reason[1]}`);
    return send(res, reason[0], { error: reason[1] });
  }

  const comment = { id: crypto.randomBytes(8).toString('hex'), name, text, at: Date.now(), ip: ipHash(ip) };
  const entry = meta[song.id] || (meta[song.id] = {});
  (entry.comments || (entry.comments = [])).push(comment);
  totalComments++;
  saveMeta();

  record('c:' + ip);
  record(`cs:${ip}|${song.id}`);
  record('c:*');
  recentPosts.push({ ip, song: song.id, norm: normalize(text), at: comment.at });
  console.log(`[comment] ${ip} on "${song.id}": ${text.slice(0, 60).replace(/\n/g, ' ')}`);
  return send(res, 201, { comment: publicComment(comment, false) });
}

function deleteComment(res, song, commentId) {
  const entry = meta[song.id];
  const comments = (entry && entry.comments) || [];
  const i = comments.findIndex((c) => c.id === commentId);
  if (i === -1) return send(res, 404, { error: 'Comment not found' });
  comments.splice(i, 1);
  totalComments--;
  tidyEntry(song.id);
  saveMeta();
  return send(res, 200, { ok: true, meta: publicEntry(meta[song.id], true) });
}

function setMarked(res, song, marked) {
  const entry = meta[song.id] || (meta[song.id] = {});
  entry.marked = !!marked;
  if (marked) entry.markedAt = entry.markedAt || Date.now();
  tidyEntry(song.id);
  saveMeta();
  return send(res, 200, { id: song.id, meta: publicEntry(meta[song.id], true) });
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function send(res, status, body, headers = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(data);
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function readJson(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    const declared = Number(req.headers['content-length']);
    if (declared > HARD_BODY_LIMIT) {
      req.destroy();
      reject(httpError(413, 'Body too large'));
      return;
    }
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        // Keep draining so the 413 can be written on a clean socket; drop
        // the connection outright if someone keeps pushing.
        tooLarge = true;
        chunks.length = 0;
        if (size > HARD_BODY_LIMIT) req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('close', () => {
      if (!req.complete) reject(httpError(400, 'Connection closed'));
    });
    req.on('end', () => {
      if (tooLarge) return reject(httpError(413, 'Body too large'));
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        const parsed = text ? JSON.parse(text) : {};
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
        resolve(parsed);
      } catch {
        reject(httpError(400, 'Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

// Turn the id segment of a URL into a safe path inside SONGS_DIR, or null.
function resolveSong(rawId) {
  let id;
  try {
    id = decodeURIComponent(rawId);
  } catch {
    return null;
  }
  if (!id || id === '.' || id === '..' || id.includes('\0') || id !== path.basename(id)) return null;
  const ext = path.extname(id).toLowerCase();
  if (!AUDIO_TYPES[ext]) return null;
  const full = path.join(SONGS_DIR, id);
  if (path.dirname(full) !== SONGS_DIR) return null;
  return { id, full, type: AUDIO_TYPES[ext] };
}

async function serveAudio(req, res, rawId) {
  const song = resolveSong(rawId);
  if (!song) return send(res, 400, { error: 'Bad song id' });

  let st;
  try {
    st = await fsp.stat(song.full);
  } catch {
    return send(res, 404, { error: 'Not found' });
  }
  if (!st.isFile()) return send(res, 404, { error: 'Not found' });

  const total = st.size;
  const headers = {
    'Content-Type': song.type,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
    'Last-Modified': st.mtime.toUTCString(),
    'X-Content-Type-Options': 'nosniff',
  };

  let status = 200;
  let start = 0;
  let end = total - 1;
  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    const bad = !m || (m[1] === '' && m[2] === '');
    if (!bad) {
      if (m[1] === '') {
        start = Math.max(0, total - Number(m[2]));
      } else {
        start = Number(m[1]);
        if (m[2] !== '') end = Math.min(Number(m[2]), total - 1);
      }
    }
    if (bad || start >= total || start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${total}` });
      return res.end();
    }
    status = 206;
    headers['Content-Range'] = `bytes ${start}-${end}/${total}`;
  }
  headers['Content-Length'] = total === 0 ? 0 : end - start + 1;
  res.writeHead(status, headers);
  if (req.method === 'HEAD' || total === 0) return res.end();

  const stream = fs.createReadStream(song.full, { start, end });
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

async function serveStatic(req, res, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
  } catch {
    return send(res, 400, { error: 'Bad path' });
  }
  const full = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!full.startsWith(PUBLIC_DIR + path.sep)) return send(res, 404, { error: 'Not found' });
  const ext = path.extname(full).toLowerCase();
  const type = STATIC_TYPES[ext];
  if (!type) return send(res, 404, { error: 'Not found' });

  let st;
  try {
    st = await fsp.stat(full);
  } catch {
    return send(res, 404, { error: 'Not found' });
  }
  if (!st.isFile()) return send(res, 404, { error: 'Not found' });

  const headers = { 'Content-Type': type, 'Content-Length': st.size, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' };
  if (ext === '.html') {
    headers['Content-Security-Policy'] = "default-src 'self'; img-src 'self' data:; media-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
    headers['Referrer-Policy'] = 'no-referrer';
    headers['X-Frame-Options'] = 'DENY';
  }
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  const stream = fs.createReadStream(full);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    const method = req.method;
    const ip = clientIp(req);

    if (p.startsWith('/audio/')) {
      if (method !== 'GET' && method !== 'HEAD') return send(res, 405, { error: 'Method not allowed' });
      if (tooMany('aud:' + ip, LIMITS.audioPerMinute, 60e3)) return send(res, 429, { error: 'Too many requests' });
      // `return await` so rejections from the helpers land in the catch below.
      return await serveAudio(req, res, p.slice('/audio/'.length));
    }

    if (p.startsWith('/api/')) {
      if (tooMany('api:' + ip, LIMITS.apiPerMinute, 60e3)) return send(res, 429, { error: 'Too many requests. Try again in a minute.' });

      if (p === '/api/songs' && method === 'GET') {
        const lib = await getLibrary(url.searchParams.has('rescan'));
        return send(res, 200, { scannedAt: lib.scannedAt, songs: lib.songs });
      }
      if (p === '/api/me' && method === 'GET') {
        return send(res, 200, { adminRequired: !!ADMIN_KEY, isAdmin: isAdmin(req, ip) });
      }
      if (p === '/api/meta' && method === 'GET') {
        return send(res, 200, publicMeta(isAdmin(req, ip)));
      }

      const commentMatch = /^\/api\/comments\/([^/]+)(?:\/([A-Za-z0-9]+))?$/.exec(p);
      if (commentMatch) {
        const song = resolveSong(commentMatch[1]);
        if (!song) return send(res, 400, { error: 'Bad song id' });
        if (method === 'POST' && !commentMatch[2]) return await postComment(req, res, song, ip);
        if (method === 'DELETE' && commentMatch[2]) {
          if (!isAdmin(req, ip)) return send(res, 403, { error: 'Admin key required' });
          return deleteComment(res, song, commentMatch[2]);
        }
        return send(res, 405, { error: 'Method not allowed' });
      }

      if (p.startsWith('/api/meta/') && (method === 'PUT' || method === 'PATCH')) {
        const song = resolveSong(p.slice('/api/meta/'.length));
        if (!song) return send(res, 400, { error: 'Bad song id' });
        if (!isAdmin(req, ip)) return send(res, 403, { error: 'Admin key required' });
        const body = await readJson(req, 1024);
        if (typeof body.marked !== 'boolean') return send(res, 400, { error: 'marked must be true or false' });
        return setMarked(res, song, body.marked);
      }
      return send(res, 404, { error: 'Not found' });
    }

    if (method === 'GET' || method === 'HEAD') return await serveStatic(req, res, p);
    return send(res, 405, { error: 'Method not allowed' });
  } catch (err) {
    if (!err.status) console.error(err);
    if (!res.headersSent) {
      // Close the connection on client errors so a half-read body is not left on the socket.
      send(res, err.status || 500, { error: err.message || 'Server error' }, err.status === 413 ? { Connection: 'close' } : {});
    } else {
      res.destroy();
    }
  }
});

server.headersTimeout = 15000;
server.requestTimeout = 60000;

// A public server should log a surprise rather than die from it.
process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));
process.on('uncaughtException', (err) => console.error('Uncaught exception:', err));

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

if (!fs.existsSync(SONGS_DIR)) {
  console.error(`Songs folder not found: ${SONGS_DIR}`);
  console.error('Set SONGS_DIR to point at your music folder.');
  process.exit(1);
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') console.error(`Port ${PORT} is already in use. Set PORT to use a different one.`);
  else console.error(err);
  process.exit(1);
});

server.listen(PORT, HOST, async () => {
  try {
    await scan();
  } catch (err) {
    console.error(`Could not scan ${SONGS_DIR}: ${err.message}`);
  }
  console.log(`${library.songs.length} songs in ${SONGS_DIR}`);
  console.log(`marks + comments in ${DATA_FILE} (${totalComments} comments)`);
  if (ADMIN_KEY) console.log('admin key set: marking and deleting comments need it');
  else console.log('WARNING: no ADMIN_KEY set, so anyone who can reach this server can mark songs and delete comments');
  if (TRUST_PROXY) console.log('trusting X-Forwarded-For for client IPs');
  console.log('');
  console.log(`  local  http://localhost:${PORT}`);
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) console.log(`  ${name.padEnd(6)} http://${a.address}:${PORT}`);
    }
  }
  console.log('');
});
