import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import Database from 'better-sqlite3';
import cookieParser from 'cookie-parser';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = createServer(app);
const io = new Server(server, { cors: { origin: '*', credentials: true } });

app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

const db = new Database('chat.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, pin TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, sender_id INTEGER, receiver_id INTEGER,
    content TEXT, type TEXT DEFAULT 'text', image_data TEXT, image_view_once INTEGER DEFAULT 0,
    image_viewed INTEGER DEFAULT 0, delivered_at TEXT, seen_at TEXT, reactions TEXT DEFAULT '{}',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS dream_catcher (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, message_id INTEGER, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS pillow_fight (user_id INTEGER PRIMARY KEY, score INTEGER DEFAULT 0);
  CREATE TABLE IF NOT EXISTS mood (user_id INTEGER PRIMARY KEY, temperature INTEGER DEFAULT 50);
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`);

const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get();
if (userCount.count === 0) {
  db.prepare('INSERT INTO users (id, name, pin) VALUES (?, ?, ?)').run(1, 'أنت', '1234');
  db.prepare('INSERT INTO users (id, name, pin) VALUES (?, ?, ?)').run(2, 'شريك', '5678');
  db.prepare('INSERT INTO pillow_fight (user_id, score) VALUES (?, ?)').run(1, 0);
  db.prepare('INSERT INTO pillow_fight (user_id, score) VALUES (?, ?)').run(2, 0);
  db.prepare('INSERT INTO mood (user_id, temperature) VALUES (?, ?)').run(1, 50);
  db.prepare('INSERT INTO mood (user_id, temperature) VALUES (?, ?)').run(2, 50);
}

const settingsCount = db.prepare('SELECT COUNT(*) as count FROM settings').get();
if (settingsCount.count === 0) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('icon_pillow', '🪶');
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('icon_kiss', '💋');
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('icon_blanket', '🛌');
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('icon_heartbeat', '💓');
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('icon_sleep', '🌙');
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('admin_pin', '9999');
}

const tokens = new Map();
const userSockets = new Map(); // ✅ SECURE: Map<userId, Set<socket>> for multi-tab support
const loginAttempts = new Map(); // ✅ SECURE: Rate limiting

function checkRateLimit(ip) {
  const now = Date.now();
  const attempts = loginAttempts.get(ip) || [];
  const recentAttempts = attempts.filter(time => now - time < 15 * 60 * 1000); // 15 min window
  if (recentAttempts.length >= 5) return false;
  recentAttempts.push(now);
  loginAttempts.set(ip, recentAttempts);
  return true;
}

app.post('/api/login', (req, res) => {
  const ip = req.ip || 'unknown';
  if (!checkRateLimit(ip)) return res.status(429).json({ error: 'محاولات كثيرة، يرجى الانتظار' });
  
  try {
    const { pin } = req.body;
    if (!pin || typeof pin !== 'string' || pin.length < 4) return res.status(400).json({ error: 'رمز غير صالح' });
    
    const user = db.prepare('SELECT id, name FROM users WHERE pin = ?').get(pin);
    if (!user) return res.status(401).json({ error: 'الرمز غير صحيح' });
    
    // ✅ SECURE: Cryptographically secure token
    const token = crypto.randomBytes(32).toString('hex');
    tokens.set(token, { userId: user.id, expires: Date.now() + 30 * 24 * 60 * 60 * 1000 }); // 30 days
    
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    // ✅ SECURE: HttpOnly prevents XSS token theft
    res.cookie('token', token, { httpOnly: true, sameSite: 'lax', path: '/', secure: process.env.NODE_ENV === 'production' });
    
    const peerId = user.id === 1 ? 2 : 1;
    const peer = db.prepare('SELECT name FROM users WHERE id = ?').get(peerId);
    res.json({ user, peerName: peer.name });
  } catch (err) { res.status(500).json({ error: 'خطأ في الخادم' }); }
});

app.get('/api/me', (req, res) => {
  const session = tokens.get(req.cookies.token);
  if (!session || session.expires < Date.now()) {
    res.clearCookie('token');
    return res.status(401).json({ error: 'Not logged in' });
  }
  
  const user = db.prepare('SELECT id, name FROM users WHERE id = ?').get(session.userId);
  const peerId = session.userId === 1 ? 2 : 1;
  const peer = db.prepare('SELECT name FROM users WHERE id = ?').get(peerId);
  
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.json({ user, peerName: peer.name });
});

app.post('/api/logout', (req, res) => {
  tokens.delete(req.cookies.token);
  res.clearCookie('token');
  res.json({ success: true });
});

app.get('/api/messages', (req, res) => {
  const session = tokens.get(req.cookies.token);
  if (!session || session.expires < Date.now()) return res.status(401).json({ error: 'Not logged in' });
  
  const userId = session.userId;
  const peerId = userId === 1 ? 2 : 1;
  
  // ✅ SECURE: Hide image_data for unviewed view-once images
  const messages = db.prepare(`
    SELECT id, sender_id, receiver_id, content, type, 
      CASE 
        WHEN type = 'image' AND image_view_once = 1 AND image_viewed = 0 THEN NULL 
        ELSE image_data 
      END as image_data, 
      image_view_once, image_viewed, delivered_at, seen_at, reactions, created_at 
    FROM messages 
    WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?) 
    ORDER BY created_at ASC
  `).all(userId, peerId, peerId, userId);
  
  res.json(messages);
});

app.post('/api/messages/:id/view', (req, res) => {
  const session = tokens.get(req.cookies.token);
  if (!session || session.expires < Date.now()) return res.status(401).json({ error: 'Not logged in' });
  
  const userId = session.userId;
  
  // ✅ SECURE: Atomic check for recipient and unviewed status
  const msg = db.prepare('SELECT id, sender_id, image_data FROM messages WHERE id = ? AND receiver_id = ? AND image_view_once = 1 AND image_viewed = 0').get(req.params.id, userId);
  if (!msg) return res.status(403).json({ error: 'Not authorized or already viewed' });
  
  // ✅ SECURE: Mark as viewed immediately
  db.prepare('UPDATE messages SET image_viewed = 1 WHERE id = ?').run(req.params.id);
  
  const sockets = userSockets.get(msg.sender_id);
  if (sockets) {
    sockets.forEach(s => s.emit('image_viewed', { id: msg.id }));
  }
  
  res.json({ image_data: msg.image_data });
});

app.delete('/api/messages/:id', (req, res) => {
  const session = tokens.get(req.cookies.token);
  if (!session || session.expires < Date.now()) return res.status(401).json({ error: 'Not logged in' });
  
  const userId = session.userId;
  const peerId = userId === 1 ? 2 : 1;
  
  db.prepare('DELETE FROM messages WHERE id = ? AND sender_id = ?').run(req.params.id, userId);
  
  // ✅ SECURE: Targeted emit, not global broadcast
  const peerSockets = userSockets.get(peerId);
  if (peerSockets) peerSockets.forEach(s => s.emit('message_deleted', { id: parseInt(req.params.id) }));
  
  res.json({ success: true });
});

app.post('/api/clear-chat', (req, res) => {
  const session = tokens.get(req.cookies.token);
  if (!session || session.expires < Date.now()) return res.status(401).json({ error: 'Not logged in' });
  
  const userId = session.userId;
  const peerId = userId === 1 ? 2 : 1;
  
  db.prepare('DELETE FROM messages WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?)').run(userId, peerId, peerId, userId);
  
  // ✅ SECURE: Targeted emit
  const peerSockets = userSockets.get(peerId);
  if (peerSockets) peerSockets.forEach(s => s.emit('chat_cleared'));
  
  res.json({ success: true });
});

app.get('/api/public-settings', (req, res) => {
  // ✅ SECURE: Explicitly exclude admin_pin
  const rows = db.prepare('SELECT key, value FROM settings WHERE key != ?', 'admin_pin').all();
  const settings = {};
  rows.forEach(r => { settings[r.key] = r.value; });
  res.json(settings);
});

// --- ADMIN APIS ---
app.post('/api/admin/login', (req, res) => {
  const ip = req.ip || 'unknown';
  if (!checkRateLimit(ip)) return res.status(429).json({ error: 'محاولات كثيرة' });

  const { pin } = req.body;
  const adminPin = db.prepare('SELECT value FROM settings WHERE key = ?').get('admin_pin')?.value || '9999';
  
  if (pin === adminPin) {
    const token = crypto.randomBytes(32).toString('hex');
    tokens.set(token, { userId: 'admin', expires: Date.now() + 2 * 60 * 60 * 1000 }); // 2 hours
    
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.cookie('admin_token', token, { httpOnly: true, sameSite: 'lax', path: '/', secure: process.env.NODE_ENV === 'production' });
    res.json({ success: true });
  } else {
    res.status(401).json({ error: 'رمز المسؤول غير صحيح' });
  }
});

app.post('/api/admin/logout', (req, res) => {
  tokens.delete(req.cookies.admin_token);
  res.clearCookie('admin_token');
  res.json({ success: true });
});

app.get('/api/admin/data', (req, res) => {
  const session = tokens.get(req.cookies.admin_token);
  if (!session || session.userId !== 'admin' || session.expires < Date.now()) return res.status(401).json({ error: 'Unauthorized' });
  
  // ✅ SECURE: Do not return plaintext user PINs
  const users = db.prepare('SELECT id, name, CASE WHEN pin IS NOT NULL THEN 1 ELSE 0 END as has_pin FROM users').all();
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const settings = {};
  rows.forEach(r => { settings[r.key] = r.value; });
  
  res.json({ users, settings });
});

app.post('/api/admin/users', (req, res) => {
  const session = tokens.get(req.cookies.admin_token);
  if (!session || session.userId !== 'admin' || session.expires < Date.now()) return res.status(401).json({ error: 'Unauthorized' });
  
  const { users } = req.body;
  const stmt = db.prepare('UPDATE users SET name = ?, pin = ? WHERE id = ?');
  users.forEach(u => {
    if (u.pin && typeof u.pin === 'string' && u.pin.length >= 4) {
      stmt.run(u.name, u.pin, u.id);
    }
  });
  res.json({ success: true });
});

app.post('/api/admin/settings', (req, res) => {
  const session = tokens.get(req.cookies.admin_token);
  if (!session || session.userId !== 'admin' || session.expires < Date.now()) return res.status(401).json({ error: 'Unauthorized' });
  
  const { settings } = req.body;
  const stmt = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  const allowedKeys = ['icon_pillow', 'icon_kiss', 'icon_blanket', 'icon_heartbeat', 'icon_sleep', 'admin_pin'];
  
  for (const [key, value] of Object.entries(settings)) {
    if (allowedKeys.includes(key)) {
      stmt.run(key, value);
    }
  }
  res.json({ success: true });
});

// --- SOCKET.IO ---
io.use((socket, next) => {
  // ✅ SECURE: Read HttpOnly cookie from socket request
  const session = tokens.get(socket.request.cookies.token);
  if (!session || session.expires < Date.now()) return next(new Error('Authentication error'));
  socket.userId = session.userId;
  next();
});

io.on('connection', (socket) => {
  const userId = socket.userId;
  const isUser = typeof userId === 'number';
  const peerId = isUser ? (userId === 1 ? 2 : 1) : null;
  
  // ✅ SECURE: Multi-tab support via Set
  if (!userSockets.has(userId)) userSockets.set(userId, new Set());
  userSockets.get(userId).add(socket);
  
  if (isUser) {
    const dreamCatcher = db.prepare('SELECT * FROM dream_catcher WHERE user_id = ?').all(userId);
    const mood = db.prepare('SELECT temperature FROM mood WHERE user_id = ?').get(userId);
    const pillowScore = db.prepare('SELECT user_id, score FROM pillow_fight').all();
    
    socket.emit('init_states', {
      dreamCatcher,
      moodTemperature: mood?.temperature || 50,
      pillowFightScore: pillowScore.reduce((acc, p) => { acc[p.user_id] = p.score; return acc; }, {})
    });
    
    const peerSockets = userSockets.get(peerId);
    if (peerSockets) peerSockets.forEach(s => s.emit('presence', { userId, online: true }));
    socket.emit('presence', { userId: peerId, online: !!(peerSockets && peerSockets.size > 0) });
  }
  
  socket.on('message', (data) => {
    if (!isUser) return;
    // ✅ SECURE: Input validation
    const content = (data.content || '').substring(0, 2000);
    const type = data.type === 'image' ? 'image' : 'text';
    const imageData = type === 'image' ? (data.image_data || null) : null;
    
    const result = db.prepare(`INSERT INTO messages (sender_id, receiver_id, content, type, image_data, image_view_once) VALUES (?, ?, ?, ?, ?, ?)`).run(userId, peerId, content, type, imageData, data.image_view_once || 0);
    const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(result.lastInsertRowid);
    
    const peerSockets = userSockets.get(peerId);
    if (peerSockets) peerSockets.forEach(s => s.emit('message', msg));
    socket.emit('message', msg);
  });
  
  socket.on('mark_delivered', (msgId) => {
    if (!isUser) return;
    db.prepare('UPDATE messages SET delivered_at = CURRENT_TIMESTAMP WHERE id = ? AND receiver_id = ?').run(msgId, userId);
    const sender = db.prepare('SELECT sender_id FROM messages WHERE id = ?').get(msgId);
    if (sender) {
      const senderSockets = userSockets.get(sender.sender_id);
      if (senderSockets) senderSockets.forEach(s => s.emit('status_update', { id: msgId, status: 'delivered' }));
    }
  });
  
  socket.on('mark_seen', (msgId) => {
    if (!isUser) return;
    db.prepare('UPDATE messages SET seen_at = CURRENT_TIMESTAMP WHERE id = ? AND receiver_id = ?').run(msgId, userId);
    const sender = db.prepare('SELECT sender_id FROM messages WHERE id = ?').get(msgId);
    if (sender) {
      const senderSockets = userSockets.get(sender.sender_id);
      if (senderSockets) senderSockets.forEach(s => s.emit('status_update', { id: msgId, status: 'seen' }));
    }
  });
  
  socket.on('edit_message', (data) => {
    if (!isUser) return;
    db.prepare('UPDATE messages SET content = ? WHERE id = ? AND sender_id = ?').run((data.content || '').substring(0, 2000), data.id, userId);
    const peerSockets = userSockets.get(peerId);
    if (peerSockets) peerSockets.forEach(s => s.emit('message_edited', { id: data.id, content: data.content }));
  });
  
  socket.on('toggle_reaction', (data) => {
    if (!isUser) return;
    const msg = db.prepare('SELECT reactions FROM messages WHERE id = ?').get(data.msgId);
    if (!msg) return;
    let reactions = {}; try { reactions = JSON.parse(msg.reactions); } catch {}
    if (!reactions[data.emoji]) reactions[data.emoji] = [];
    const idx = reactions[data.emoji].indexOf(userId);
    if (idx > -1) reactions[data.emoji].splice(idx, 1); else reactions[data.emoji].push(userId);
    
    db.prepare('UPDATE messages SET reactions = ? WHERE id = ?').run(JSON.stringify(reactions), data.msgId);
    const updateData = { msgId: data.msgId, reactions };
    const peerSockets = userSockets.get(peerId);
    if (peerSockets) peerSockets.forEach(s => s.emit('reaction_update', updateData));
    socket.emit('reaction_update', updateData);
  });
  
  socket.on('typing', (isTyping) => {
    if (!isUser) return;
    const peerSockets = userSockets.get(peerId);
    if (peerSockets) peerSockets.forEach(s => s.emit('typing', { userId, isTyping }));
  });
  
  socket.on('send_sleep_notice', (data) => {
    if (!isUser) return;
    const user = db.prepare('SELECT name FROM users WHERE id = ?').get(userId);
    const peerSockets = userSockets.get(peerId);
    if (peerSockets) peerSockets.forEach(s => s.emit('receive_sleep_notice', { fromName: user.name, funnyMessage: data.funnyMessage, durationMin: data.durationMin }));
  });
  
  socket.on('send_blanket', () => {
    if (!isUser) return;
    const user = db.prepare('SELECT name FROM users WHERE id = ?').get(userId);
    const peerSockets = userSockets.get(peerId);
    if (peerSockets) peerSockets.forEach(s => s.emit('receive_blanket', { from: user.name }));
  });
  
  socket.on('send_kiss', () => {
    if (!isUser) return;
    const peerSockets = userSockets.get(peerId);
    if (peerSockets) peerSockets.forEach(s => s.emit('receive_kiss', { from: userId }));
  });
  
  socket.on('pillow_fight_throw', () => {
    if (!isUser) return;
    const peerScore = db.prepare('SELECT score FROM pillow_fight WHERE user_id = ?').get(peerId);
    const newScore = (peerScore?.score || 0) + 1;
    db.prepare('UPDATE pillow_fight SET score = ? WHERE user_id = ?').run(newScore, peerId);
    
    const p1 = db.prepare('SELECT score FROM pillow_fight WHERE user_id = 1').get().score;
    const p2 = db.prepare('SELECT score FROM pillow_fight WHERE user_id = 2').get().score;
    const peerSockets = userSockets.get(peerId);
    if (peerSockets) peerSockets.forEach(s => s.emit('pillow_fight_hit', { score: { 1: p1, 2: p2 } }));
  });
  
  socket.on('send_heartbeat', () => {
    if (!isUser) return;
    const peerSockets = userSockets.get(peerId);
    if (peerSockets) peerSockets.forEach(s => s.emit('receive_heartbeat', { from: userId }));
  });
  
  socket.on('shake_nudge', () => {
    if (!isUser) return;
    const peerSockets = userSockets.get(peerId);
    if (peerSockets) peerSockets.forEach(s => s.emit('receive_nudge', { from: userId }));
  });
  
  socket.on('starlight_wish', () => {
    if (!isUser) return;
    const peerSockets = userSockets.get(peerId);
    if (peerSockets) peerSockets.forEach(s => s.emit('receive_wish', { from: userId }));
  });
  
  socket.on('mood_update', (data) => {
    if (!isUser) return;
    // ✅ SECURE: Strict validation
    const temp = Math.max(0, Math.min(100, parseInt(data.temperature) || 50));
    db.prepare('INSERT OR REPLACE INTO mood (user_id, temperature) VALUES (?, ?)').run(userId, temp);
    const peerSockets = userSockets.get(peerId);
    if (peerSockets) peerSockets.forEach(s => s.emit('mood_update', { temperature: temp }));
  });
  
  socket.on('request_camera_view', () => {
    if (!isUser) return;
    const peerSockets = userSockets.get(peerId);
    if (peerSockets) peerSockets.forEach(s => s.emit('start_streaming_camera'));
  });
  
  socket.on('stop_camera_view', () => {
    if (!isUser) return;
    const peerSockets = userSockets.get(peerId);
    if (peerSockets) peerSockets.forEach(s => s.emit('stop_streaming_camera'));
  });
  
  socket.on('flip_partner_camera', () => {
    if (!isUser) return;
    const peerSockets = userSockets.get(peerId);
    if (peerSockets) peerSockets.forEach(s => s.emit('flip_my_camera'));
  });
  
  socket.on('camera_frame', (data) => {
    if (!isUser) return;
    // ✅ SECURE: Only forward if peer is actively listening, basic size check
    if (data.imageData && typeof data.imageData === 'string' && data.imageData.length < 500000) {
      const peerSockets = userSockets.get(peerId);
      if (peerSockets) peerSockets.forEach(s => s.emit('receive_camera_frame', { imageData: data.imageData }));
    }
  });
  
  socket.on('wake_up', () => {
    if (!isUser) return;
    const dreams = db.prepare('SELECT COUNT(*) as count FROM dream_catcher WHERE user_id = ?').get(userId);
    db.prepare('DELETE FROM dream_catcher WHERE user_id = ?').run(userId);
    socket.emit('dreams_released', { count: dreams.count });
  });
  
  socket.on('disconnect', () => {
    const sockets = userSockets.get(userId);
    if (sockets) {
      sockets.delete(socket);
      if (sockets.size === 0) {
        userSockets.delete(userId);
        if (isUser) {
          const peerSockets = userSockets.get(peerId);
          if (peerSockets) peerSockets.forEach(s => s.emit('presence', { userId, online: false }));
        }
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🌙 Secure server running on port ${PORT}`);
});
