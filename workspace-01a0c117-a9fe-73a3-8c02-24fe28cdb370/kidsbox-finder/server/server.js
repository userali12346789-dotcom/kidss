#!/usr/bin/env node
/**
 * Kid's Box Student Finder — server
 *
 * Zero-dependency Node.js server:
 *   - serves the static frontend from ./public
 *   - exposes minimal, privacy-conscious lookup APIs
 *   - the student database (./data/students.json) is NEVER served to clients
 *
 * API:
 *   GET /api/meta                        -> { classes, demo, loaded }
 *   GET /api/suggest?q=...               -> { suggestions: [{id, name}] } (max 8, names only)
 *   GET /api/lookup?name=...&class=...   -> { status: found|ambiguous|not_found|not_found_in_class|invalid_input, ... }
 *   GET /api/student?id=...              -> public record only {name, className, cycle, group, book}
 *   GET /api/health                      -> { ok: true }
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const DATA_FILE = path.join(__dirname, 'data', 'students.json');

/* ------------------------------------------------------------------ *
 * Data loading & index
 * ------------------------------------------------------------------ */

let DATA = { loaded: false, demo: false, classes: [], students: [] };
let INDEX = { students: [], byId: new Map() };

function loadDatabase() {
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    const students = Array.isArray(raw.students) ? raw.students : [];

    const valid = students.filter(
      (s) =>
        s &&
        typeof s.id === 'string' &&
        typeof s.name === 'string' &&
        s.name.trim().length >= 3 &&
        typeof s.className === 'string' &&
        s.className.trim().length > 0 &&
        typeof s.group === 'number' &&
        typeof s.book === 'string' &&
        s.book.trim().length > 0
    );

    const byId = new Map();
    const indexed = valid.map((s, i) => {
      const name = s.name.replace(/\s+/g, ' ').trim();
      const normName = normalize(name);
      const tokens = normName.split(' ');
      const revTokens = [...tokens].reverse();
      const rec = {
        seq: i,
        id: s.id,
        name,
        normName,
        tokens,
        revTokens,
        revName: revTokens.join(' '),
        className: s.className,
        normClass: normalize(s.className),
        cycle: s.cycle || null,
        group: s.group,
        book: s.book.replace(/\s+/g, ' ').trim(),
      };
      byId.set(rec.id, rec);
      return rec;
    });

    DATA = {
      loaded: indexed.length > 0,
      demo: raw.demo === true,
      classes: Array.isArray(raw.classes) ? raw.classes.slice() : [...new Set(indexed.map((r) => r.className))],
      students: indexed,
      demoNote: raw.note || null,
    };
    INDEX = { students: indexed, byId };
  } catch (err) {
    console.error('[db] failed to load dataset:', err.message);
    DATA = { loaded: false, demo: false, classes: [], students: [], demoNote: null };
    INDEX = { students: [], byId: new Map() };
  }
}

/* ------------------------------------------------------------------ *
 * Text normalization (accent-, case- and punctuation-insensitive)
 * ------------------------------------------------------------------ */

function normalize(str) {
  if (typeof str !== 'string') return '';
  let s = str.normalize('NFKC').toLowerCase();
  s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); // strip accents
  s = s.replace(/[^\p{L}\p{N}]+/gu, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

/* ------------------------------------------------------------------ *
 * Safe matching (NO fuzzy / Levenshtein — accuracy over recall)
 * ------------------------------------------------------------------ */

/** All query tokens must be prefixes of distinct name tokens (order-agnostic). */
function allTokensPrefix(qTokens, nameTokens) {
  if (qTokens.length === 0) return false;
  if (qTokens.length > nameTokens.length) return false;

  const used = new Array(nameTokens.length).fill(false);
  const assign = (qi) => {
    if (qi === qTokens.length) return true;
    for (let ni = 0; ni < nameTokens.length; ni++) {
      if (!used[ni] && nameTokens[ni].startsWith(qTokens[qi])) {
        used[ni] = true;
        if (assign(qi + 1)) return true;
        used[ni] = false;
      }
    }
    return false;
  };
  return assign(0);
}

/** All query tokens must appear (substring) inside distinct name tokens (order-agnostic). */
function allTokensSubstr(qTokens, nameTokens) {
  if (qTokens.length === 0) return false;
  if (qTokens.length > nameTokens.length) return false;
  const used = new Array(nameTokens.length).fill(false);
  const assign = (qi) => {
    if (qi === qTokens.length) return true;
    for (let ni = 0; ni < nameTokens.length; ni++) {
      if (!used[ni] && nameTokens[ni].includes(qTokens[qi])) {
        used[ni] = true;
        if (assign(qi + 1)) return true;
        used[ni] = false;
      }
    }
    return false;
  };
  return assign(0);
}

/**
 * Autocomplete suggestions.
 * Tiers: exact full-name > prefix match > substring match. Never more than 8.
 */
function suggest(query, limit = 8) {
  const q = normalize(query);
  if (q.length < 1) return [];
  const qTokens = q.split(' ');

  const scored = [];
  for (const s of INDEX.students) {
    let score = 0;
    if (s.normName === q) score = 1000;
    else if (s.revName === q) score = 950;
    else if (allTokensPrefix(qTokens, s.tokens)) score = 500;
    else if (allTokensPrefix(qTokens, s.revTokens)) score = 480;
    else if (allTokensSubstr(qTokens, s.tokens) || allTokensSubstr(qTokens, s.revTokens)) score = 100;
    if (score === 0) continue;
    // shorter full names first on ties, then stable ordering
    scored.push({ s, score, order: s.seq });
  }

  scored.sort((a, b) => b.score - a.score || a.s.normName.length - b.s.normName.length || a.order - b.order);
  return scored.slice(0, limit).map(({ s }) => ({ id: s.id, name: s.name }));
}

/**
 * Authoritative lookup for the "Find my book" button.
 * Safe rules:
 *   1. exact normalized full-name match (either token order)
 *   2. otherwise token-prefix match (order-agnostic) — e.g. "achamrah"
 * Never fuzzy. 0, 1 or N candidates -> not_found / found / ambiguous.
 */
function lookup(query, className) {
  const q = normalize(query);
  const classFilter = normalize(className || '');
  if (q.length < 3) return { status: 'invalid_input' };

  const qTokens = q.split(' ');
  const inClass = (s) => !classFilter || s.normClass === classFilter;

  // pass 1 — exact normalized full-name match
  let exact = INDEX.students.filter((s) => (s.normName === q || s.revName === q) && inClass(s));
  if (exact.length > 0) {
    if (exact.length === 1) return { status: 'found', student: publicRecord(exact[0]) };
    return { status: 'ambiguous', candidates: exact.map((s) => candidateRecord(s)) };
  }

  // pass 2 — token prefix match (no typos tolerated, prefixes only)
  const prefix = INDEX.students.filter(
    (s) => inClass(s) && (allTokensPrefix(qTokens, s.tokens) || allTokensPrefix(qTokens, s.revTokens))
  );
  if (prefix.length > 0) {
    if (prefix.length === 1) return { status: 'found', student: publicRecord(prefix[0]) };
    return { status: 'ambiguous', candidates: prefix.map((s) => candidateRecord(s)) };
  }

  // no match inside the class filter, but matches exist elsewhere -> helpful hint
  if (classFilter) {
    const elsewhere = INDEX.students.filter(
      (s) => s.normName === q || s.revName === q || allTokensPrefix(qTokens, s.tokens) || allTokensPrefix(qTokens, s.revTokens)
    );
    if (elsewhere.length > 0) {
      return {
        status: 'not_found_in_class',
        message: `Student found in ${elsewhere.map((s) => s.className).join(', ')}, but not in the selected class.`,
        otherMatches: elsewhere.map((s) => candidateRecord(s)),
      };
    }
  }
  return { status: 'not_found' };
}

function publicRecord(s) {
  // ONLY public fields — never score, confidence, remarks or ranking
  return {
    id: s.id,
    name: s.name,
    className: s.className,
    cycle: s.cycle,
    group: `Groupe ${s.group}`,
    book: s.book,
  };
}

function candidateRecord(s) {
  // ambiguity list: name + original class only
  return { id: s.id, name: s.name, className: s.className };
}

/* ------------------------------------------------------------------ *
 * Rate limiting (privacy: prevent roster enumeration)
 * ------------------------------------------------------------------ */

const buckets = new Map();
function rateLimited(ip, limit, windowMs) {
  const now = Date.now();
  let b = buckets.get(ip);
  if (!b || now - b.start > windowMs) {
    b = { start: now, count: 0 };
    buckets.set(ip, b);
  }
  b.count += 1;
  return b.count > limit;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, b] of buckets) if (now - b.start > 120000) buckets.delete(ip);
}, 60000).unref();

/* ------------------------------------------------------------------ *
 * HTTP plumbing
 * ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

function sendJSON(res, code, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...securityHeaders(),
    ...extraHeaders,
  });
  res.end(body);
}

function securityHeaders() {
  return {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Access-Control-Allow-Origin': '*',
  };
}

function parseQuery(url) {
  const qi = url.indexOf('?');
  const params = new URLSearchParams(qi >= 0 ? url.slice(qi + 1) : '');
  return params;
}

function serveStatic(res, pathname) {
  let filePath = pathname === '/' ? '/index.html' : pathname;
  if (filePath === '/result') filePath = '/result.html';
  filePath = path.normalize(filePath).replace(/^([.][.][/\\])+/, '');
  const abs = path.join(PUBLIC_DIR, filePath);
  if (!abs.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, securityHeaders());
    return res.end('Forbidden');
  }
  fs.readFile(abs, (err, buf) => {
    if (err) {
      res.writeHead(404, { ...securityHeaders(), 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    const ext = path.extname(abs).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': buf.length,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
      ...securityHeaders(),
    });
    res.end(buf);
  });
}

const server = http.createServer((req, res) => {
  const url = req.url || '/';
  const pathname = decodeURIComponent(url.split('?')[0]);
  const ip = req.socket.remoteAddress || 'unknown';

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJSON(res, 405, { error: 'Method not allowed' });
    return;
  }

  try {
    if (pathname.startsWith('/api/')) {
      const params = parseQuery(url);

      if (pathname === '/api/health') {
        sendJSON(res, 200, { ok: true, loaded: DATA.loaded });
        return;
      }

      if (pathname === '/api/meta') {
        sendJSON(res, 200, {
          loaded: DATA.loaded,
          demo: DATA.demo,
          demoNote: DATA.demoNote || null,
          classes: DATA.classes,
        });
        return;
      }

      if (pathname === '/api/suggest') {
        if (rateLimited(ip, 120, 60000)) return sendJSON(res, 429, { error: 'Too many requests. Please slow down.', suggestions: [] });
        const q = (params.get('q') || '').slice(0, 60);
        if (!DATA.loaded) return sendJSON(res, 200, { suggestions: [], loaded: false });
        sendJSON(res, 200, { suggestions: suggest(q) });
        return;
      }

      if (pathname === '/api/lookup') {
        if (rateLimited(ip, 60, 60000)) return sendJSON(res, 429, { error: 'Too many requests. Please slow down.', status: 'error' });
        if (!DATA.loaded) return sendJSON(res, 200, { status: 'not_found' });
        const name = (params.get('name') || '').slice(0, 80);
        const cls = (params.get('class') || '').slice(0, 20);
        sendJSON(res, 200, lookup(name, cls));
        return;
      }

      if (pathname === '/api/student') {
        if (rateLimited(ip, 120, 60000)) return sendJSON(res, 429, { error: 'Too many requests. Please slow down.' });
        const id = (params.get('id') || '').trim();
        const rec = INDEX.byId.get(id);
        if (!rec) return sendJSON(res, 404, { error: 'Student not found' });
        sendJSON(res, 200, publicRecord(rec));
        return;
      }

      sendJSON(res, 404, { error: 'Unknown API route' });
      return;
    }

    serveStatic(res, pathname);
  } catch (err) {
    console.error('[request error]', err.message);
    sendJSON(res, 500, { error: 'Something went wrong. Please try again.' });
  }
});

loadDatabase();
console.log(`[kidsbox-finder] db loaded: ${DATA.loaded ? DATA.students.length + ' students (demo=' + DATA.demo + ')' : 'NONE'}`);
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[kidsbox-finder] listening on 0.0.0.0:${PORT}`);
});
