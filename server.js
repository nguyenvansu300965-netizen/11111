'use strict';

const express = require('express');
const { Pool } = require('pg');
const crypto = require('crypto');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);

const { runDataMigration } = require('./migration');
const { runCloudflareD1Migration } = require('./scripts/migrate-from-cloudflare');
const { getStickyIdentity, buildStickyCookie } = require('./sticky');

// ─── Database ────────────────────────────────────────────────────────────────

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway')
    ? { rejectUnauthorized: false }
    : false
});

const STICKY_CACHE_TTL_MS = 5 * 60 * 1000;
const stickyAssignmentCache = new Map();
const domainHealthCache = new Map();
const DOMAIN_HEALTH_CACHE_TTL_MS = 60 * 1000;

// ─── Password helpers (scrypt) ────────────────────────────────────────────────

const SCRYPT_KEYLEN = 64;
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = await scrypt(password, salt, SCRYPT_KEYLEN, SCRYPT_PARAMS);
  return `${salt}:${derived.toString('hex')}`;
}

async function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const derived = await scrypt(password, salt, SCRYPT_KEYLEN, SCRYPT_PARAMS);
  const derivedHex = derived.toString('hex');
  // Constant-time comparison
  return crypto.timingSafeEqual(
    Buffer.from(derivedHex, 'hex'),
    Buffer.from(hash, 'hex')
  );
}

// ─── Short ID generation ──────────────────────────────────────────────────────

function newId() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz';
  let id = '';

  for (let i = 0; i < 6; i += 1) {
    id += alphabet[crypto.randomInt(alphabet.length)];
  }

  return id;
}

// ─── Express app ─────────────────────────────────────────────────────────────

const app = express();

// Parse JSON bodies — accept both application/json and text/plain (frontend sends text/plain)
app.use((req, res, next) => {
  let data = '';
  req.on('data', chunk => { data += chunk; });
  req.on('end', () => {
    if (data) {
      try {
        req.body = JSON.parse(data);
      } catch {
        req.body = {};
      }
    } else {
      req.body = {};
    }
    next();
  });
});

// CORS
app.use((req, res, next) => {
  const origin = req.headers.origin || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Admin-Token,X-User-Password');
  res.setHeader('Vary', 'Origin');
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  next();
});

// ─── Static files ─────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

app.use(express.static(__dirname));

// ─── Health check ─────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'link-dispatch-railway' });
});

// ─── Redirect route ───────────────────────────────────────────────────────────

app.get('/r/:id', async (req, res) => {
  const id = req.params.id;
  try {
    const result = await nextUrlInternal(id, {
      ua: req.headers['user-agent'] || '',
      ref: req.headers['referer'] || '',
      ip: extractClientIp(req),
      cookie: req.headers.cookie || ''
    }, {
      asyncMetrics: true
    });
    res.setHeader('Cache-Control', 'no-store');
    if (result.setCookie) {
      res.setHeader('Set-Cookie', result.setCookie);
    }
    res.redirect(302, result.url);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Internal error' });
  }
});

const RESERVED_SHORT_PATHS = new Set(['api', 'health', 'index.html', 'redirect.html', '11111']);

app.get('/:id', async (req, res, next) => {
  const id = String(req.params.id || '').trim();

  if (!/^[A-Za-z0-9_-]{4,64}$/.test(id) || RESERVED_SHORT_PATHS.has(id)) {
    return next();
  }

  try {
    const result = await nextUrlInternal(id, {
      ua: req.headers['user-agent'] || '',
      ref: req.headers['referer'] || '',
      ip: extractClientIp(req),
      cookie: req.headers.cookie || ''
    }, {
      asyncMetrics: true
    });
    res.setHeader('Cache-Control', 'no-store');
    if (result.setCookie) {
      res.setHeader('Set-Cookie', result.setCookie);
    }
    res.redirect(302, result.url);
  } catch (err) {
    if (err && err.status === 404) {
      return next();
    }
    res.status(err.status || 500).json({ error: err.message || 'Internal error' });
  }
});

// ─── Main API endpoint ────────────────────────────────────────────────────────

app.post('/api', async (req, res) => {
  try {
    const payload = req.body || {};
    const action = String(payload.action || '').trim();
    const result = await handleAction(action, payload, req);
    res.json(result);
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ error: err.message || 'Internal error' });
  }
});

// ─── Cloudflare D1 migration endpoint ────────────────────────────────────────

app.post('/api/migrate', async (req, res) => {
  try {
    console.log('[/api/migrate] Starting Cloudflare D1 → PostgreSQL migration…');
    const result = await runCloudflareD1Migration({ pgPool: pool });
    console.log('[/api/migrate] Migration finished successfully.');
    res.json(result);
  } catch (err) {
    console.error('[/api/migrate] Migration failed:', err.message);
    res.status(500).json({ success: false, error: err.message || 'Migration failed' });
  }
});

// ─── Action dispatcher ────────────────────────────────────────────────────────

async function handleAction(action, payload, req) {
  switch (action) {
    case 'register':
      return handleRegister(payload);
    case 'login':
      return handleLogin(payload);
    case 'getDomainOptions':
      return handleGetDomainOptions(req);
    case 'createSet':
      return handleCreateSet(payload, req);
    case 'listSets':
      return handleListSets(payload, req);
    case 'nextUrl':
      return handleNextUrl(payload, req);
    case 'getStats':
      return handleGetStats(payload, req);
    case 'updateSet':
      return handleUpdateSet(payload, req);
    case 'listUsers':
      return handleListUsers(payload, req);
    case 'authorizeUser':
      return handleAuthorizeUser(payload, req);
    case 'revokeUser':
      return handleRevokeUser(payload, req);
    case 'setUserPassword':
      return handleSetUserPassword(payload, req);
    default:
      throw httpError(400, 'Unsupported action');
  }
}

// ─── Domain options ──────────────────────────────────────────────────────────

function getConfiguredDomains(req) {
  const configuredDomains = process.env.ALLOWED_DOMAINS || process.env.DOMAIN_OPTIONS || 'whttapp.dev,www.whttapp.dev';
  const rawDomains = `${configuredDomains},https://waatapp.pro`;
  const values = rawDomains.split(',');
  const host = req && req.get('host');
  if (host) {
    const forwardedProtocol = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
    const protocol = /^https?$/i.test(forwardedProtocol) ? forwardedProtocol : 'https';
    values.push(`${protocol}://${host}`);
  }

  const seen = new Set();
  const domains = [];

  for (const entry of values) {
    const trimmed = String(entry || '').trim();
    if (!trimmed) continue;

    let normalized;
    try {
      const url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
      normalized = url.origin;
    } catch {
      continue;
    }

    if (!seen.has(normalized)) {
      seen.add(normalized);
      domains.push(normalized);
    }
  }

  return domains;
}

async function handleGetDomainOptions(req) {
  const domains = getConfiguredDomains(req);
  const currentOrigin = getRequestOrigin(req);
  const availability = await Promise.all(domains.map(domain =>
    domain === currentOrigin || isDomainHealthy(domain)
  ));

  return {
    ok: true,
    domains: domains.filter((_, index) => availability[index])
  };
}

function getRequestOrigin(req) {
  const host = req && req.get('host');
  if (!host) return '';

  const forwardedProtocol = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
  const protocol = /^https?$/i.test(forwardedProtocol) ? forwardedProtocol : 'https';
  try {
    return new URL(`${protocol}://${host}`).origin;
  } catch {
    return '';
  }
}

async function isDomainHealthy(domain) {
  const cached = domainHealthCache.get(domain);
  if (cached && Date.now() - cached.checkedAt < DOMAIN_HEALTH_CACHE_TTL_MS) {
    return cached.healthy;
  }

  let healthy = false;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2500);
    try {
      const response = await fetch(`${domain}/health`, {
        signal: controller.signal,
        redirect: 'manual'
      });
      if (response.ok) {
        const payload = await response.json();
        healthy = payload && payload.ok === true && ['link-dispatch-railway', 'link-dispatch-worker'].includes(payload.service);
      }
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    healthy = false;
  }

  domainHealthCache.set(domain, { healthy, checkedAt: Date.now() });
  return healthy;
}

// ─── Auth: register ───────────────────────────────────────────────────────────

async function handleRegister(payload) {
  const username = String(payload.username || '').trim();
  const password = String(payload.password || '').trim();

  if (!username || !password) {
    throw httpError(400, '用户名和密码不能为空');
  }
  if (username.length > 32 || password.length > 128) {
    throw httpError(400, '用户名或密码过长');
  }

  const client = await pool.connect();
  try {
    // Check if username already exists
    const existing = await client.query(
      'SELECT id FROM users WHERE username = $1',
      [username]
    );
    if (existing.rows.length > 0) {
      throw httpError(409, '用户名已存在');
    }

    // Determine role: first user is admin
    const countResult = await client.query('SELECT COUNT(*) AS cnt FROM users');
    const isFirst = Number(countResult.rows[0].cnt) === 0;
    const role = isFirst ? 'admin' : 'user';
    const isAuthorized = isFirst; // 管理员自动授权

    const passwordHash = await hashPassword(password);
    const now = new Date().toISOString();

    const insertResult = await client.query(
      'INSERT INTO users (username, password_hash, role, is_authorized, created_at) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [username, passwordHash, role, isAuthorized, now]
    );

    const userId = insertResult.rows[0].id;
    return {
      ok: true,
      user: { id: userId, username, role }
    };
  } finally {
    client.release();
  }
}

// ─── Auth: login ──────────────────────────────────────────────────────────────

async function handleLogin(payload) {
  const username = String(payload.username || '').trim();
  const password = String(payload.password || '').trim();

  if (!username || !password) {
    throw httpError(400, '用户名和密码不能为空');
  }

  const client = await pool.connect();
  try {
    const result = await client.query(
      'SELECT id, username, password_hash, role, is_authorized FROM users WHERE username = $1',
      [username]
    );
    if (result.rows.length === 0) {
      throw httpError(401, '用户名不存在');
    }

    const user = result.rows[0];
    const valid = await verifyPassword(password, user.password_hash);
    if (!valid) {
      throw httpError(401, '密码错误');
    }

    if (!user.is_authorized) {
      throw httpError(401, '账号未授权，请联系管理员');
    }

    return {
      ok: true,
      user: { id: user.id, username: user.username, role: user.role }
    };
  } finally {
    client.release();
  }
}

// ─── Resolve authenticated user from payload ──────────────────────────────────

async function resolveUser(payload) {
  const username = String(payload.username || '').trim();
  const password = String(payload.password || '').trim();

  if (!username || !password) {
    throw httpError(401, '未登录，请先登录');
  }

  const client = await pool.connect();
  try {
    const result = await client.query(
      'SELECT id, username, password_hash, role FROM users WHERE username = $1',
      [username]
    );
    if (result.rows.length === 0) {
      throw httpError(401, '用户名不存在');
    }

    const user = result.rows[0];
    const valid = await verifyPassword(password, user.password_hash);
    if (!valid) {
      throw httpError(401, '密码错误');
    }

    return user;
  } finally {
    client.release();
  }
}

// ─── createSet ────────────────────────────────────────────────────────────────

async function handleCreateSet(payload, req) {
  const user = await resolveUser(payload);

  const links = sanitizeLinks(payload.links);
  const name = typeof payload.name === 'string' ? payload.name.trim().slice(0, 120) : '';
  const now = new Date().toISOString();

  const client = await pool.connect();
  try {
    const id = await allocateSetId(client);
    await client.query(
      'INSERT INTO link_sets (id, name, links_json, current_index, click_count, created_at, updated_at, owner_id) VALUES ($1, $2, $3, 0, 0, $4, $5, $6)',
      [id, name, JSON.stringify(links), now, now, user.id]
    );

    return { ok: true, id };
  } finally {
    client.release();
  }
}

// ─── updateSet ────────────────────────────────────────────────────────────────

async function handleUpdateSet(payload, req) {
  const user = await resolveUser(payload);

  const id = sanitizeId(String(payload.id || '').trim());
  const links = sanitizeLinks(payload.links);
  const name = typeof payload.name === 'string' ? payload.name.trim().slice(0, 120) : '';
  const now = new Date().toISOString();

  const client = await pool.connect();
  try {
    // Admin can edit all link sets; regular users can only edit their own.
    const existing = await client.query(
      'SELECT id, owner_id FROM link_sets WHERE id = $1',
      [id]
    );
    if (existing.rows.length === 0) {
      throw httpError(404, '链接集合不存在');
    }
    if (user.role !== 'admin' && existing.rows[0].owner_id !== user.id) {
      throw httpError(403, '无权修改该链接集合');
    }

    if (user.role === 'admin') {
      await client.query(
        'UPDATE link_sets SET name = $1, links_json = $2, updated_at = $3 WHERE id = $4',
        [name, JSON.stringify(links), now, id]
      );
    } else {
      await client.query(
        'UPDATE link_sets SET name = $1, links_json = $2, updated_at = $3 WHERE id = $4 AND owner_id = $5',
        [name, JSON.stringify(links), now, id, user.id]
      );
    }
  } finally {
    client.release();
  }

  return { ok: true, id };
}

// ─── listSets ─────────────────────────────────────────────────────────────────

async function handleListSets(payload, req) {
  const user = await resolveUser(payload);
  const limit = clampLimit(Number(payload.limit || 20));
  const offset = clampOffset(Number(payload.offset || 0));

  const client = await pool.connect();
  try {
    const result = user.role === 'admin'
      ? await client.query(
        `SELECT s.id, s.name, s.links_json, s.current_index, s.click_count, s.created_at, s.updated_at,
                u.username AS owner_username
         FROM link_sets s
         LEFT JOIN users u ON u.id = s.owner_id
         ORDER BY s.created_at DESC
         LIMIT $1 OFFSET $2`,
        [limit + 1, offset]
      )
      : await client.query(
        `SELECT s.id, s.name, s.links_json, s.current_index, s.click_count, s.created_at, s.updated_at,
                u.username AS owner_username
         FROM link_sets s
         LEFT JOIN users u ON u.id = s.owner_id
         WHERE s.owner_id = $1
         ORDER BY s.created_at DESC
         LIMIT $2 OFFSET $3`,
        [user.id, limit + 1, offset]
      );
    const rows = result.rows.slice(0, limit);
    const hasMore = result.rows.length > limit;

    const items = rows.map(row => {
      const links = safeParseArray(row.links_json);
      return {
        id: row.id,
        name: row.name || '',
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        currentIndex: Number(row.current_index || 0),
        clickCount: Number(row.click_count || 0),
        username: row.owner_username || '',
        count: links.length,
        links
      };
    });

    return { items, offset, limit, hasMore };
  } finally {
    client.release();
  }
}

// ─── nextUrl (internal) ───────────────────────────────────────────────────────

async function nextUrlInternal(rawId, meta, options = {}) {
  const id = sanitizeId(rawId);
  const asyncMetrics = options.asyncMetrics === true;
  let client = null;
  try {
    const ua = typeof meta.ua === 'string' ? meta.ua.slice(0, 500) : '';
    const ref = typeof meta.ref === 'string' ? meta.ref.slice(0, 1000) : '';
    const ip = typeof meta.ip === 'string' ? meta.ip.slice(0, 100) : '';
    const stickyIdentity = getStickyIdentity({ cookieHeader: meta.cookie || '', ip });
    const resolvedCookieValue = stickyIdentity.cookieValue || `customer-${crypto.randomUUID()}`;
    const identityHash = crypto.createHash('sha256').update(resolvedCookieValue).digest('hex');
    const setCookie = stickyIdentity.cookieValue ? null : buildStickyCookie(resolvedCookieValue);
    const now = new Date().toISOString();
    const logId = crypto.randomUUID();

    const cachedSticky = getStickyAssignmentCache(id, identityHash);
    if (cachedSticky) {
      if (asyncMetrics) {
        scheduleAccessMetrics({
          id,
          index: cachedSticky.index,
          url: cachedSticky.url,
          now,
          logId,
          ua,
          ref,
          ipHash: identityHash,
          touchAssignment: true
        });
      } else {
        await recordAccessMetrics({
          id,
          index: cachedSticky.index,
          url: cachedSticky.url,
          now,
          logId,
          ua,
          ref,
          ipHash: identityHash,
          touchAssignment: true
        });
      }

      return {
        ok: true,
        id,
        index: cachedSticky.index,
        url: cachedSticky.url,
        nextUrl: cachedSticky.url,
        sticky: true,
        cached: true,
        setCookie
      };
    }

    client = await pool.connect();

    const stickyResult = await client.query(
      `SELECT link_index, url
       FROM ip_assignments
       WHERE set_id = $1 AND ip_hash = $2
       LIMIT 1`,
      [id, identityHash]
    );

    if (stickyResult.rows.length > 0) {
      const stickyRow = stickyResult.rows[0];
      const stickyIndex = Number(stickyRow.link_index || 0);
      const stickyUrl = String(stickyRow.url || '');

      if (!stickyUrl || !/^https?:\/\//i.test(stickyUrl)) {
        throw httpError(409, 'Stored URL is invalid');
      }

      setStickyAssignmentCache(id, identityHash, stickyIndex, stickyUrl);

      if (asyncMetrics) {
        scheduleAccessMetrics({
          id,
          index: stickyIndex,
          url: stickyUrl,
          now,
          logId,
          ua,
          ref,
          ipHash: identityHash,
          touchAssignment: true
        });
      } else {
        await recordAccessMetrics({
          id,
          index: stickyIndex,
          url: stickyUrl,
          now,
          logId,
          ua,
          ref,
          ipHash: identityHash,
          touchAssignment: true
        });
      }

      return { ok: true, id, index: stickyIndex, url: stickyUrl, nextUrl: stickyUrl, sticky: true, setCookie };
    }

    await client.query('BEGIN');

    const setResult = await client.query(
      'SELECT id, links_json, current_index FROM link_sets WHERE id = $1 FOR UPDATE',
      [id]
    );
    if (setResult.rows.length === 0) {
      throw httpError(404, 'Link set not found');
    }

    const lockedStickyResult = await client.query(
      `SELECT link_index, url
       FROM ip_assignments
       WHERE set_id = $1 AND ip_hash = $2
       LIMIT 1`,
      [id, identityHash]
    );

    if (lockedStickyResult.rows.length > 0) {
      const stickyRow = lockedStickyResult.rows[0];
      const stickyIndex = Number(stickyRow.link_index || 0);
      const stickyUrl = String(stickyRow.url || '');

      if (!stickyUrl || !/^https?:\/\//i.test(stickyUrl)) {
        throw httpError(409, 'Stored URL is invalid');
      }
      await client.query('COMMIT');
      setStickyAssignmentCache(id, identityHash, stickyIndex, stickyUrl);

      if (asyncMetrics) {
        scheduleAccessMetrics({
          id,
          index: stickyIndex,
          url: stickyUrl,
          now,
          logId,
          ua,
          ref,
          ipHash: identityHash,
          touchAssignment: true
        });
      } else {
        await recordAccessMetrics({
          id,
          index: stickyIndex,
          url: stickyUrl,
          now,
          logId,
          ua,
          ref,
          ipHash: identityHash,
          touchAssignment: true
        });
      }

      return { ok: true, id, index: stickyIndex, url: stickyUrl, nextUrl: stickyUrl, sticky: true, setCookie };
    }

    const row = setResult.rows[0];
    const links = safeParseArray(row.links_json);
    if (links.length === 0) {
      throw httpError(409, 'Link set is empty');
    }

    const currentIndex = normalizeIndex(Number(row.current_index || 0), links.length);
    const url = links[currentIndex];

    if (!url || !/^https?:\/\//i.test(url)) {
      throw httpError(409, 'Stored URL is invalid');
    }

    const nextIndex = (currentIndex + 1) % links.length;

    await client.query(
      'UPDATE link_sets SET current_index = $1, updated_at = $2 WHERE id = $3',
      [nextIndex, now, id]
    );

    await client.query(
      `INSERT INTO ip_assignments (set_id, ip_hash, link_index, url, assigned_at, last_clicked_at)
       VALUES ($1, $2, $3, $4, $5, $5)
       ON CONFLICT (set_id, ip_hash) DO UPDATE
       SET last_clicked_at = EXCLUDED.last_clicked_at`,
      [id, identityHash, currentIndex, url, now]
    );
    setStickyAssignmentCache(id, identityHash, currentIndex, url);

    await client.query('COMMIT');

    if (asyncMetrics) {
      scheduleAccessMetrics({
        id,
        index: currentIndex,
        url,
        now,
        logId,
        ua,
        ref,
        ipHash: identityHash,
        touchAssignment: false,
        bumpClickCount: true
      });
    } else {
      await recordAccessMetrics({
        id,
        index: currentIndex,
        url,
        now,
        logId,
        ua,
        ref,
        ipHash: identityHash,
        touchAssignment: false,
        bumpClickCount: true
      });
    }

    return { ok: true, id, index: currentIndex, url, nextUrl: url, setCookie };
  } catch (error) {
    if (client) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Ignore rollback failures; the original error is more useful.
      }
    }
    throw error;
  } finally {
    if (client) {
      client.release();
    }
  }
}

function scheduleAccessMetrics(payload) {
  setImmediate(() => {
    recordAccessMetrics(payload).catch(error => {
      console.error('[metrics] Failed to persist access metrics:', error.message);
    });
  });
}

async function recordAccessMetrics(payload) {
  const client = await pool.connect();
  try {
    // Metrics writes are best-effort background work, so avoid an extra explicit
    // transaction here to reduce latency on the redirect hot path.
    if (payload.bumpClickCount !== false) {
      await client.query(
        'UPDATE link_sets SET click_count = COALESCE(click_count, 0) + 1, updated_at = $1 WHERE id = $2',
        [payload.now, payload.id]
      );
    }

    if (payload.touchAssignment && payload.ipHash) {
      await client.query(
        'UPDATE ip_assignments SET last_clicked_at = $1 WHERE set_id = $2 AND ip_hash = $3',
        [payload.now, payload.id, payload.ipHash]
      );
    }

    await client.query(
      'INSERT INTO click_logs (log_id, set_id, link_index, url, clicked_at, ua, ref, ip_hash) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
      [payload.logId, payload.id, payload.index, payload.url, payload.now, payload.ua, payload.ref, payload.ipHash]
    );
  } catch (error) {
    throw error;
  } finally {
    client.release();
  }
}

// ─── nextUrl (API action) ─────────────────────────────────────────────────────

async function handleNextUrl(payload, req) {
  const rawId = String(payload.id || payload.set_id || '').trim();
  if (!rawId) {
    throw httpError(400, '缺少 id 参数');
  }

  const meta = {
    ua: payload.ua || req.headers['user-agent'] || '',
    ref: payload.ref || req.headers['referer'] || '',
    ip: extractClientIp(req)
  };

  return nextUrlInternal(rawId, meta);
}

// ─── getStats ─────────────────────────────────────────────────────────────────

async function handleGetStats(payload, req) {
  const rawId = String(payload.id || payload.set_id || '').trim();
  if (!rawId) {
    throw httpError(400, '缺少 id 参数');
  }

  const id = sanitizeId(rawId);
  const client = await pool.connect();
  try {
    const setResult = await client.query(
      'SELECT links_json FROM link_sets WHERE id = $1',
      [id]
    );
    if (setResult.rows.length === 0) {
      throw httpError(404, 'Link set not found');
    }

    const links = safeParseArray(setResult.rows[0].links_json);

    const logsResult = await client.query(
      'SELECT link_index, COUNT(*) AS clicks, MAX(clicked_at) AS last_clicked_at FROM click_logs WHERE set_id = $1 GROUP BY link_index ORDER BY link_index ASC',
      [id]
    );

    const counts = new Map(
      logsResult.rows.map(row => [
        Number(row.link_index || 0),
        { clicks: Number(row.clicks || 0), lastClickedAt: row.last_clicked_at || null }
      ])
    );

    const stats = links.map((url, index) => {
      const stat = counts.get(index) || { clicks: 0, lastClickedAt: null };
      return { index, url, clicks: stat.clicks, lastClickedAt: stat.lastClickedAt };
    });

    return { id, stats };
  } finally {
    client.release();
  }
}

// ─── Admin: listUsers ─────────────────────────────────────────────────────────

async function handleListUsers(payload, req) {
  const admin = await resolveUser(payload);
  if (admin.role !== 'admin') {
    throw httpError(403, '只有管理员可以管理账号');
  }

  const client = await pool.connect();
  try {
    const result = await client.query(
      'SELECT id, username, role, is_authorized, created_at FROM users ORDER BY created_at DESC'
    );
    return { users: result.rows };
  } finally {
    client.release();
  }
}

// ─── Admin: authorizeUser ─────────────────────────────────────────────────────

async function handleAuthorizeUser(payload, req) {
  const admin = await resolveUser(payload);
  if (admin.role !== 'admin') {
    throw httpError(403, '只有管理员可以管理账号');
  }

  const userId = Number(payload.userId || 0);
  if (!userId) {
    throw httpError(400, '缺少 userId 参数');
  }

  const client = await pool.connect();
  try {
    await client.query(
      'UPDATE users SET is_authorized = true WHERE id = $1',
      [userId]
    );
    return { ok: true };
  } finally {
    client.release();
  }
}

// ─── Admin: revokeUser ────────────────────────────────────────────────────────

async function handleRevokeUser(payload, req) {
  const admin = await resolveUser(payload);
  if (admin.role !== 'admin') {
    throw httpError(403, '只有管理员可以管理账号');
  }

  const userId = Number(payload.userId || 0);
  if (!userId) {
    throw httpError(400, '缺少 userId 参数');
  }

  // 防止管理员撤销自己的权限
  if (admin.id === userId) {
    throw httpError(400, '无法撤销自己的权限');
  }

  const client = await pool.connect();
  try {
    await client.query(
      'UPDATE users SET is_authorized = false WHERE id = $1',
      [userId]
    );
    return { ok: true };
  } finally {
    client.release();
  }
}

// ─── Admin: setUserPassword ──────────────────────────────────────────────────

async function handleSetUserPassword(payload, req) {
  const admin = await resolveUser(payload);
  if (admin.role !== 'admin') {
    throw httpError(403, '只有管理员可以管理账号');
  }

  const userId = Number(payload.userId || 0);
  const newPassword = String(payload.newPassword || '').trim();
  if (!userId) {
    throw httpError(400, '缺少 userId 参数');
  }
  if (!newPassword) {
    throw httpError(400, '新密码不能为空');
  }
  if (newPassword.length > 128) {
    throw httpError(400, '新密码过长');
  }

  const client = await pool.connect();
  try {
    const existing = await client.query(
      'SELECT id, username FROM users WHERE id = $1',
      [userId]
    );
    if (existing.rows.length === 0) {
      throw httpError(404, '用户不存在');
    }

    const passwordHash = await hashPassword(newPassword);
    await client.query(
      'UPDATE users SET password_hash = $1 WHERE id = $2',
      [passwordHash, userId]
    );

    return {
      ok: true,
      user: {
        id: existing.rows[0].id,
        username: existing.rows[0].username
      }
    };
  } finally {
    client.release();
  }
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function sanitizeId(value) {
  const id = String(value || '').trim();
  if (!/^[a-zA-Z0-9_-]{4,64}$/.test(id)) {
    throw httpError(400, 'Invalid id');
  }
  return id;
}

function sanitizeLinks(links) {
  console.log('[sanitizeLinks] Input type:', typeof links);
  console.log('[sanitizeLinks] Input value:', JSON.stringify(links).slice(0, 200));

  // 检查是否是无效的对象字符串表示
  if (typeof links === 'string' && links === '[object Object]') {
    throw httpError(400, '链接数据格式错误：前端发送了无效的对象表示');
  }

  // 如果是字符串，按换行符分割
  if (typeof links === 'string') {
    console.log('[sanitizeLinks] Converting string to array...');
    links = links.split('\n').map(line => line.trim()).filter(Boolean);
    console.log('[sanitizeLinks] After split:', links.length, 'items');
  }

  if (!Array.isArray(links)) {
    throw httpError(400, 'links 必须是数组或字符串');
  }
  const clean = links
    .map(item => String(item || '').trim())
    .filter(Boolean)
    .filter(item => /^https?:\/\//i.test(item));

  if (clean.length === 0) {
    throw httpError(400, '至少需要一个有效的 http/https 链接');
  }
  if (clean.length > 500) {
    throw httpError(400, '链接数量不能超过 500');
  }
  return clean;
}

function safeParseArray(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeIndex(value, length) {
  const parsed = Number(value || 0);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed) % length;
}

function clampLimit(value) {
  if (!Number.isFinite(value) || value <= 0) return 20;
  return Math.min(Math.floor(value), 500);
}

function clampOffset(value) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.max(0, Math.floor(value));
}

async function allocateSetId(client) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const id = newId();
    const existing = await client.query(
      'SELECT 1 FROM link_sets WHERE id = $1 LIMIT 1',
      [id]
    );
    if (existing.rows.length === 0) {
      return id;
    }
  }

  throw httpError(409, 'Failed to allocate a unique id');
}

function getStickyAssignmentCache(setId, ipHash) {
  const key = `${setId}:${ipHash}`;
  const cached = stickyAssignmentCache.get(key);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    stickyAssignmentCache.delete(key);
    return null;
  }
  return cached;
}

function setStickyAssignmentCache(setId, ipHash, index, url) {
  stickyAssignmentCache.set(`${setId}:${ipHash}`, {
    index,
    url,
    expiresAt: Date.now() + STICKY_CACHE_TTL_MS
  });
}

function extractClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket.remoteAddress || '';
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// ─── Startup migration ────────────────────────────────────────────────────────

async function runMigrations() {
  const client = await pool.connect();
  try {
    // Ensure tables exist (idempotent)
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user',
        created_at TEXT NOT NULL
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS link_sets (
        id TEXT PRIMARY KEY,
        name TEXT DEFAULT '',
        links_json TEXT NOT NULL,
        current_index INTEGER NOT NULL DEFAULT 0,
        click_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS click_logs (
        log_id TEXT PRIMARY KEY,
        set_id TEXT NOT NULL,
        link_index INTEGER NOT NULL,
        url TEXT NOT NULL,
        clicked_at TEXT NOT NULL,
        ua TEXT DEFAULT '',
        ref TEXT DEFAULT '',
        ip_hash TEXT DEFAULT ''
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS ip_assignments (
        set_id TEXT NOT NULL,
        ip_hash TEXT NOT NULL,
        link_index INTEGER NOT NULL,
        url TEXT NOT NULL,
        assigned_at TEXT NOT NULL,
        last_clicked_at TEXT NOT NULL,
        PRIMARY KEY (set_id, ip_hash)
      )
    `);

    // Add owner_id column to link_sets if it doesn't exist
    await client.query(`
      ALTER TABLE link_sets ADD COLUMN IF NOT EXISTS owner_id INTEGER
    `);

    // Add is_authorized column to users if it doesn't exist
    await client.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS is_authorized BOOLEAN DEFAULT false
    `);

    // Indexes
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_click_logs_set_id ON click_logs(set_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_click_logs_set_ip_hash_clicked_at ON click_logs(set_id, ip_hash, clicked_at)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_ip_assignments_set_last_clicked_at ON ip_assignments(set_id, last_clicked_at)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_link_sets_owner_id ON link_sets(owner_id)
    `);

    console.log('Database migrations complete');
  } catch (err) {
    console.error('Migration error:', err.message);
  } finally {
    client.release();
  }
}

// ─── Start server ─────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;

runMigrations().then(() => {
  return runDataMigration(pool);
}).then(() => {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}).catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
