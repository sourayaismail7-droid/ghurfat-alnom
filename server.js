import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import Database from 'better-sqlite3';
import cookieParser from 'cookie-parser';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.set('trust proxy', 1);

const server = createServer(app);

const io = new Server(server, {
  maxHttpBufferSize: 2 * 1024 * 1024,
  pingInterval: 25000,
  pingTimeout: 20000,
  allowRequest: (req, callback) => {
    const origin = req.headers.origin;
    if (!origin) return callback(null, true);
    try {
      const originUrl = new URL(origin);
      const forwardedHost = req.headers['x-forwarded-host'];
      const requestHost = String(forwardedHost || req.headers.host || '').split(',')[0].trim();
      callback(null, !!requestHost && originUrl.host === requestHost);
    } catch {
      callback(null, false);
    }
  }
});

app.use(express.json({ limit: '12mb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

const db = new Database(path.join(__dirname, 'chat.db'));
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, pin TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, sender_id INTEGER, receiver_id INTEGER,
    content TEXT, type TEXT DEFAULT 'text', image_data TEXT, image_view_once INTEGER DEFAULT 0,
    image_viewed INTEGER DEFAULT 0, delivered_at TEXT, seen_at TEXT, reactions TEXT DEFAULT '{}',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP, client_id TEXT
  );
  CREATE TABLE IF NOT EXISTS dream_catcher (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, message_id INTEGER, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS pillow_fight (user_id INTEGER PRIMARY KEY, score INTEGER DEFAULT 0);
  CREATE TABLE IF NOT EXISTS mood (user_id INTEGER PRIMARY KEY, temperature INTEGER DEFAULT 50);
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`);

function hasColumn(table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column);
}
if (!hasColumn('messages', 'client_id')) {
  db.exec(`ALTER TABLE messages ADD COLUMN client_id TEXT`);
}
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_sender_client ON messages(sender_id, client_id) WHERE client_id IS NOT NULL`);

const userCount = db.prepare('SELECT COUNT(*) AS count FROM users').get();
if (userCount.count === 0) {
  const tx = db.transaction(() => {
    db.prepare('INSERT INTO users (id, name, pin) VALUES (?, ?, ?)').run(1, 'أنت', '1234');
    db.prepare('INSERT INTO users (id, name, pin) VALUES (?, ?, ?)').run(2, 'شريك', '5678');
    db.prepare('INSERT INTO pillow_fight (user_id, score) VALUES (?, ?)').run(1, 0);
    db.prepare('INSERT INTO pillow_fight (user_id, score) VALUES (?, ?)').run(2, 0);
    db.prepare('INSERT INTO mood (user_id, temperature) VALUES (?, ?)').run(1, 50);
    db.prepare('INSERT INTO mood (user_id, temperature) VALUES (?, ?)').run(2, 50);
  });
  tx();
}

for (const id of [1, 2]) {
  db.prepare('INSERT OR IGNORE INTO pillow_fight (user_id, score) VALUES (?, 0)').run(id);
  db.prepare('INSERT OR IGNORE INTO mood (user_id, temperature) VALUES (?, 50)').run(id);
}

const defaultSettings = { icon_pillow: '🪶', icon_kiss: '💋', icon_blanket: '🛌', icon_heartbeat: '💓', icon_sleep: '🌙', admin_pin: '9999' };
const settingStmt = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
for (const [key, value] of Object.entries(defaultSettings)) settingStmt.run(key, value);

/* ========================================================= SESSIONS ========================================================= */
const sessions = new Map();
const socketsByUser = new Map();
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function makeToken() { return crypto.randomBytes(32).toString('hex'); }
function createSession(kind, userId = null) {
  const token = makeToken();
  sessions.set(token, { kind, userId, createdAt: Date.now(), expiresAt: Date.now() + SESSION_TTL_MS });
  return token;
}
function getSession(token, expectedKind = null) {
  if (!token) return null;
  const session = sessions.get(token);
  if (!session || (expectedKind && session.kind !== expectedKind) || session.expiresAt <= Date.now()) {
    if (session) sessions.delete(token);
    return null;
  }
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  return session;
}
function destroySession(token) { if (token) sessions.delete(token); }
function setAuthCookie(res, name, token) {
  res.cookie(name, token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge: SESSION_TTL_MS });
}
function clearAuthCookie(res, name) {
  res.clearCookie(name, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/' });
}
function userFromRequest(req) {
  const session = getSession(req.cookies.token, 'user');
  return session ? session.userId : null;
}
function adminFromRequest(req) { return !!getSession(req.cookies.admin_token, 'admin'); }

/* ========================================================= HELPERS ========================================================= */
function peerOf(userId) { return userId === 1 ? 2 : 1; }
function getUser(userId) { return db.prepare('SELECT id, name FROM users WHERE id = ?').get(userId); }
function emitToUser(userId, event, payload) {
  const set = socketsByUser.get(userId);
  if (!set) return;
  for (const socket of set) { if (socket.connected) socket.emit(event, payload); }
}
function isUserOnline(userId) {
  const set = socketsByUser.get(userId);
  return !!set && [...set].some(socket => socket.connected);
}
function addSocket(userId, socket) {
  let set = socketsByUser.get(userId);
  const wasOnline = !!set && set.size > 0;
  if (!set) { set = new Set(); socketsByUser.set(userId, set); }
  set.add(socket);
  return !wasOnline;
}
function removeSocket(userId, socket) {
  const set = socketsByUser.get(userId);
  if (!set) return false;
  set.delete(socket);
  if (set.size === 0) { socketsByUser.delete(userId); return true; }
  return false;
}
function safeInt(value, fallback = 0) { const n = Number(value); return Number.isInteger(n) ? n : fallback; }
function validImageData(value) { return typeof value === 'string' && value.length > 0 && value.length <= 1200000; }
function validText(value) { return typeof value === 'string' && value.length <= 10000; }
function sanitizeUserInput(value, max = 100) { return String(value ?? '').trim().slice(0, max); }
function parseCookieHeader(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key) continue;
    try { out[key] = decodeURIComponent(value); } catch { out[key] = value; }
  }
  return out;
}

/* ========================================================= HTTP ROUTES ========================================================= */
app.post('/api/login', (req, res) => {
  try {
    const pin = sanitizeUserInput(req.body?.pin, 32);
    if (!pin) return res.status(400).json({ error: 'PIN is required' });
    const user = db.prepare('SELECT id, name, pin FROM users WHERE pin = ?').get(pin);
    if (!user) return res.status(401).json({ error: 'الرمز غير صحيح' });
    const token = createSession('user', user.id);
    setAuthCookie(res, 'token', token);
    const peer = getUser(peerOf(user.id));
    res.json({ user: { id: user.id, name: user.name }, peerName: peer?.name || 'شريك' });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

app.get('/api/me', (req, res) => {
  const userId = userFromRequest(req);
  if (!userId) return res.status(401).json({ error: 'Not logged in' });
  const user = getUser(userId);
  const peer = getUser(peerOf(userId));
  if (!user) return res.status(401).json({ error: 'Not logged in' });
  res.json({ user, peerName: peer?.name || 'شريك' });
});

app.post('/api/logout', (req, res) => {
  destroySession(req.cookies.token);
  clearAuthCookie(res, 'token');
  res.json({ success: true });
});

app.get('/api/messages', (req, res) => {
  const userId = userFromRequest(req);
  if (!userId) return res.status(401).json({ error: 'Not logged in' });
  const peerId = peerOf(userId);
  
  // ✅ CRITICAL FIX: Mask image_data for unviewed view-once messages
  const messages = db.prepare(`
    SELECT id, sender_id, receiver_id, content, type,
      CASE WHEN type = 'image' AND image_view_once = 1 AND image_viewed = 0 THEN NULL ELSE image_data END AS image_data,
      image_view_once, image_viewed, delivered_at, seen_at, reactions, created_at, client_id
    FROM messages
    WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?)
    ORDER BY id ASC
  `).all(userId, peerId, peerId, userId);
  res.json(messages);
});

app.post('/api/messages/:id/view', (req, res) => {
  const userId = userFromRequest(req);
  if (!userId) return res.status(401).json({ error: 'Not logged in' });
  const id = safeInt(req.params.id);
  const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
  if (!msg || msg.receiver_id !== userId || msg.image_view_once !== 1) {
    return res.status(404).json({ error: 'Not found' });
  }
  db.prepare('UPDATE messages SET image_viewed = 1 WHERE id = ?').run(id);
  emitToUser(msg.sender_id, 'image_viewed', { id: msg.id });
  res.json({ image_data: msg.image_data });
});

app.delete('/api/messages/:id', (req, res) => {
  const userId = userFromRequest(req);
  if (!userId) return res.status(401).json({ error: 'Not logged in' });
  const id = safeInt(req.params.id);
  const result = db.prepare('DELETE FROM messages WHERE id = ? AND sender_id = ?').run(id, userId);
  if (result.changes > 0) {
    const peerId = peerOf(userId);
    emitToUser(peerId, 'message_deleted', { id });
    emitToUser(userId, 'message_deleted', { id });
  }
  res.json({ success: true, deleted: result.changes > 0 });
});

app.post('/api/clear-chat', (req, res) => {
  const userId = userFromRequest(req);
  if (!userId) return res.status(401).json({ error: 'Not logged in' });
  const peerId = peerOf(userId);
  db.prepare(`DELETE FROM messages WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?)`).run(userId, peerId, peerId, userId);
  emitToUser(userId, 'chat_cleared');
  emitToUser(peerId, 'chat_cleared');
  res.json({ success: true });
});

app.get('/api/public-settings', (req, res) => {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const settings = {};
  for (const row of rows) settings[row.key] = row.value;
  delete settings.admin_pin; // ✅ Security: Never expose admin PIN publicly
  res.json(settings);
});

app.post('/api/admin/login', (req, res) => {
  const pin = sanitizeUserInput(req.body?.pin, 64);
  const adminPin = db.prepare('SELECT value FROM settings WHERE key = ?').get('admin_pin')?.value || '9999';
  if (pin !== adminPin) return res.status(401).json({ error: 'رمز المسؤول غير صحيح' });
  const token = createSession('admin');
  setAuthCookie(res, 'admin_token', token);
  res.json({ success: true });
});

app.post('/api/admin/logout', (req, res) => {
  destroySession(req.cookies.admin_token);
  clearAuthCookie(res, 'admin_token');
  res.json({ success: true });
});

app.get('/api/admin/data', (req, res) => {
  if (!adminFromRequest(req)) return res.status(401).json({ error: 'Unauthorized' });
  const users = db.prepare('SELECT id, name FROM users ORDER BY id').all();
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const settings = {};
  for (const row of rows) { if (row.key !== 'admin_pin') settings[row.key] = row.value; }
  res.json({ users: users.map(u => ({ ...u, pin: '' })), settings, adminPinConfigured: true });
});

app.post('/api/admin/users', (req, res) => {
  if (!adminFromRequest(req)) return res.status(401).json({ error: 'Unauthorized' });
  const users = Array.isArray(req.body?.users) ? req.body.users : [];
  const update = db.prepare('UPDATE users SET name = ?, pin = ? WHERE id = ?');
  const tx = db.transaction(() => {
    for (const item of users) {
      const id = safeInt(item?.id);
      if (![1, 2].includes(id)) continue;
      const current = db.prepare('SELECT name, pin FROM users WHERE id = ?').get(id);
      if (!current) continue;
      const name = sanitizeUserInput(item?.name, 80) || current.name;
      const submittedPin = sanitizeUserInput(item?.pin, 32);
      const pin = submittedPin || current.pin;
      update.run(name, pin, id);
    }
  });
  tx();
  res.json({ success: true });
});

app.post('/api/admin/settings', (req, res) => {
  if (!adminFromRequest(req)) return res.status(401).json({ error: 'Unauthorized' });
  const settings = req.body?.settings;
  if (!settings || typeof settings !== 'object') return res.status(400).json({ error: 'Invalid settings' });
  const allowed = new Set(['icon_pillow', 'icon_kiss', 'icon_blanket', 'icon_heartbeat', 'icon_sleep', 'admin_pin']);
  const stmt = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  for (const [key, value] of Object.entries(settings)) {
    if (!allowed.has(key)) continue;
    const clean = sanitizeUserInput(value, key === 'admin_pin' ? 64 : 20);
    if (!clean) continue;
    stmt.run(key, clean);
  }
  res.json({ success: true });
});

/* ========================================================= SOCKET.IO ========================================================= */
io.use((socket, next) => {
  try {
    const cookies = parseCookieHeader(socket.handshake.headers.cookie || '');
    const session = getSession(cookies.token, 'user');
    if (!session?.userId) return next(new Error('AUTH_REQUIRED'));
    socket.userId = session.userId;
    socket.sessionToken = cookies.token;
    next();
  } catch (err) { next(new Error('AUTH_REQUIRED')); }
});

function sendPresenceToPeer(userId, online) { emitToUser(peerOf(userId), 'presence', { userId, online }); }
function sendCurrentStates(socket, userId) {
  const dreamCatcher = db.prepare('SELECT * FROM dream_catcher WHERE user_id = ? ORDER BY id ASC').all(userId);
  const mood = db.prepare('SELECT temperature FROM mood WHERE user_id = ?').get(userId);
  const pillowRows = db.prepare('SELECT user_id, score FROM pillow_fight ORDER BY user_id').all();
  socket.emit('init_states', {
    dreamCatcher,
    moodTemperature: mood?.temperature ?? 50,
    pillowFightScore: pillowRows.reduce((acc, row) => { acc[row.user_id] = row.score; return acc; }, {})
  });
}

io.on('connection', (socket) => {
  const userId = socket.userId;
  const peerId = peerOf(userId);
  const becameOnline = addSocket(userId, socket);
  console.log(`[socket] connected user=${userId} socket=${socket.id}`);
  sendCurrentStates(socket, userId);
  socket.emit('presence', { userId: peerId, online: isUserOnline(peerId) });
  if (becameOnline) sendPresenceToPeer(userId, true);

  socket.on('message', (data, ack) => {
    try {
      const content = validText(data?.content) ? data.content : '';
      const type = data?.type === 'image' ? 'image' : 'text';
      const clientId = sanitizeUserInput(data?.client_id, 100) || null;
      const imageData = type === 'image' && validImageData(data?.image_data) ? data.image_data : null;
      const viewOnce = imageData && Number(data?.image_view_once) === 1 ? 1 : 0;

      if (type === 'text' && !content.trim()) return ack?.({ ok: false, error: 'EMPTY_MESSAGE' });
      if (type === 'image' && !imageData) return ack?.({ ok: false, error: 'INVALID_IMAGE' });

      let msg;
      if (clientId) {
        msg = db.prepare('SELECT * FROM messages WHERE sender_id = ? AND client_id = ?').get(userId, clientId);
      }
      if (!msg) {
        const result = db.prepare(`INSERT INTO messages (sender_id, receiver_id, content, type, image_data, image_view_once, client_id) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(userId, peerId, content, type, imageData, viewOnce, clientId);
        msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(result.lastInsertRowid);
      }
      emitToUser(peerId, 'message', msg);
      emitToUser(userId, 'message', msg);
      ack?.({ ok: true, message: msg });
    } catch (err) {
      console.error('message event error:', err);
      ack?.({ ok: false, error: 'MESSAGE_FAILED' });
    }
  });

  socket.on('mark_delivered', (msgId) => {
    const id = safeInt(msgId);
    const msg = db.prepare('SELECT id, sender_id, receiver_id FROM messages WHERE id = ?').get(id);
    if (!msg || msg.receiver_id !== userId) return;
    db.prepare('UPDATE messages SET delivered_at = COALESCE(delivered_at, CURRENT_TIMESTAMP) WHERE id = ?').run(id);
    emitToUser(msg.sender_id, 'status_update', { id, status: 'delivered' });
  });

  socket.on('mark_seen', (msgId) => {
    const id = safeInt(msgId);
    const msg = db.prepare('SELECT id, sender_id, receiver_id FROM messages WHERE id = ?').get(id);
    if (!msg || msg.receiver_id !== userId) return;
    db.prepare('UPDATE messages SET seen_at = CURRENT_TIMESTAMP, delivered_at = COALESCE(delivered_at, CURRENT_TIMESTAMP) WHERE id = ?').run(id);
    emitToUser(msg.sender_id, 'status_update', { id, status: 'seen' });
  });

  socket.on('edit_message', (data, ack) => {
    const id = safeInt(data?.id);
    const content = validText(data?.content) ? data.content.trim() : '';
    if (!id || !content) return ack?.({ ok: false });
    const result = db.prepare('UPDATE messages SET content = ? WHERE id = ? AND sender_id = ? AND type = ?').run(content, id, userId, 'text');
    if (result.changes) {
      emitToUser(peerId, 'message_edited', { id, content });
      emitToUser(userId, 'message_edited', { id, content });
    }
    ack?.({ ok: !!result.changes });
  });

  socket.on('reaction', (data) => updateReaction(userId, peerId, data, false));
  socket.on('toggle_reaction', (data) => updateReaction(userId, peerId, data, true));
  socket.on('typing', (isTyping) => emitToUser(peerId, 'typing', { userId, isTyping: !!isTyping }));

  socket.on('send_sleep_notice', (data) => {
    const user = getUser(userId);
    emitToUser(peerId, 'receive_sleep_notice', {
      fromName: user?.name || 'شريكك',
      funnyMessage: sanitizeUserInput(data?.funnyMessage, 500),
      durationMin: Math.max(0, Math.min(1440, safeInt(data?.durationMin)))
    });
  });

  socket.on('send_blanket', () => { emitToUser(peerId, 'receive_blanket', { from: getUser(userId)?.name || 'شريكك' }); });
  socket.on('send_kiss', () => { emitToUser(peerId, 'receive_kiss', { from: userId }); });
  socket.on('send_heartbeat', () => { emitToUser(peerId, 'receive_heartbeat', { from: userId }); });
  socket.on('shake_nudge', () => { emitToUser(peerId, 'receive_nudge', { from: userId }); });
  socket.on('starlight_wish', () => { emitToUser(peerId, 'receive_wish', { from: userId }); });

  socket.on('pillow_fight_throw', () => {
    const row = db.prepare('SELECT score FROM pillow_fight WHERE user_id = ?').get(peerId);
    const newScore = (row?.score || 0) + 1;
    db.prepare('UPDATE pillow_fight SET score = ? WHERE user_id = ?').run(newScore, peerId);
    const p1 = db.prepare('SELECT score FROM pillow_fight WHERE user_id = 1').get()?.score || 0;
    const p2 = db.prepare('SELECT score FROM pillow_fight WHERE user_id = 2').get()?.score || 0;
    const payload = { score: { 1: p1, 2: p2 } };
    emitToUser(peerId, 'pillow_fight_hit', payload);
    emitToUser(userId, 'pillow_fight_hit', payload);
  });

  socket.on('mood_update', (data) => {
    const temperature = Math.max(0, Math.min(100, safeInt(data?.temperature, 50)));
    db.prepare('INSERT OR REPLACE INTO mood (user_id, temperature) VALUES (?, ?)').run(userId, temperature);
    emitToUser(peerId, 'mood_update', { temperature });
  });

  // ✅ WebRTC Camera Signaling
  socket.on('camera_request', () => { emitToUser(peerId, 'camera_request', { fromUserId: userId, requesterSocketId: socket.id }); });
  socket.on('camera_offer', (data) => { if (isUserOnline(peerId) && typeof data?.sdp === 'object') emitToUser(peerId, 'camera_offer', { fromUserId: userId, fromSocketId: socket.id, toSocketId: data.toSocketId, sdp: data.sdp }); });
  socket.on('camera_answer', (data) => { if (isUserOnline(peerId) && typeof data?.sdp === 'object') emitToUser(peerId, 'camera_answer', { fromUserId: userId, fromSocketId: socket.id, toSocketId: data.toSocketId, sdp: data.sdp }); });
  socket.on('camera_ice', (data) => { if (isUserOnline(peerId) && data?.candidate) emitToUser(peerId, 'camera_ice', { fromUserId: userId, fromSocketId: socket.id, toSocketId: data.toSocketId, candidate: data.candidate }); });
  socket.on('camera_stop', (data) => { emitToUser(peerId, 'camera_stop', { fromUserId: userId, fromSocketId: socket.id, toSocketId: data?.toSocketId || null }); });
  socket.on('camera_flip_request', (data) => { emitToUser(peerId, 'camera_flip_request', { fromUserId: userId, fromSocketId: socket.id, toSocketId: data?.toSocketId || null }); });

  socket.on('wake_up', () => {
    const dreams = db.prepare('SELECT COUNT(*) AS count FROM dream_catcher WHERE user_id = ?').get(userId);
    db.prepare('DELETE FROM dream_catcher WHERE user_id = ?').run(userId);
    socket.emit('dreams_released', { count: dreams.count });
    emitToUser(peerId, 'dream_catcher_update', { userId, count: 0 });
  });

  socket.on('disconnect', (reason) => {
    const becameOffline = removeSocket(userId, socket);
    console.log(`[socket] disconnected user=${userId} socket=${socket.id} reason=${reason}`);
    emitToUser(peerId, 'camera_stop', { fromUserId: userId, fromSocketId: socket.id, toSocketId: null });
    if (becameOffline) sendPresenceToPeer(userId, false);
  });
});

function updateReaction(userId, peerId, data, toggle) {
  const msgId = safeInt(data?.msgId);
  const emoji = sanitizeUserInput(data?.emoji, 16);
  if (!msgId || !emoji) return;
  const msg = db.prepare('SELECT id, sender_id, receiver_id, reactions FROM messages WHERE id = ?').get(msgId);
  if (!msg || ![msg.sender_id, msg.receiver_id].includes(userId)) return;
  let reactions = {};
  try { reactions = JSON.parse(msg.reactions || '{}'); } catch { reactions = {}; }
  if (!Array.isArray(reactions[emoji])) reactions[emoji] = [];
  if (toggle) {
    const idx = reactions[emoji].indexOf(userId);
    if (idx >= 0) reactions[emoji].splice(idx, 1); else reactions[emoji].push(userId);
  } else if (!reactions[emoji].includes(userId)) {
    reactions[emoji].push(userId);
  }
  if (reactions[emoji].length === 0) delete reactions[emoji];
  db.prepare('UPDATE messages SET reactions = ? WHERE id = ?').run(JSON.stringify(reactions), msgId);
  const payload = { msgId, reactions };
  emitToUser(peerId, 'reaction_update', payload);
  emitToUser(userId, 'reaction_update', payload);
}

app.get('/healthz', (req, res) => {
  res.json({ ok: true, uptime: process.uptime(), sockets: [...socketsByUser.values()].reduce((sum, set) => sum + set.size, 0) });
});

const PORT = Number(process.env.PORT) || 3000;
server.listen(PORT, '0.0.0.0', () => { console.log(`🌙 Ghurfat Al-Nom server listening on port ${PORT}`); });

function shutdown(signal) {
  console.log(`Received ${signal}; closing server...`);
  for (const set of socketsByUser.values()) { for (const socket of set) { try { socket.disconnect(true); } catch {} } }
  try { db.close(); } catch {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
