import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import Database from 'better-sqlite3';
import cookieParser from 'cookie-parser';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

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

const tokens = {};
const userSockets = {};

app.post('/api/login', (req, res) => {
  try {
    const { pin } = req.body;
    if (!pin) return res.status(400).json({ error: 'PIN is required' });
    const user = db.prepare('SELECT * FROM users WHERE pin = ?').get(pin);
    if (!user) return res.status(401).json({ error: 'الرمز غير صحيح' });
    
    const token = Math.random().toString(36).substring(2) + Math.random().toString(36).substring(2);
    tokens[token] = user.id;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.cookie('token', token, { httpOnly: false, sameSite: 'lax', path: '/' });
    
    const peerId = user.id === 1 ? 2 : 1;
    const peer = db.prepare('SELECT name FROM users WHERE id = ?').get(peerId);
    res.json({ user, peerName: peer.name });
  } catch (err) { res.status(500).json({ error: 'خطأ في الخادم' }); }
});

app.get('/api/me', (req, res) => {
  const userId = tokens[req.cookies.token];
  if (!userId) return res.status(401).json({ error: 'Not logged in' });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  const peer = db.prepare('SELECT name FROM users WHERE id = ?').get(userId === 1 ? 2 : 1);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.json({ user, peerName: peer.name });
});

app.post('/api/logout', (req, res) => {
  delete tokens[req.cookies.token];
  res.clearCookie('token');
  res.json({ success: true });
});

app.get('/api/messages', (req, res) => {
  const userId = tokens[req.cookies.token];
  if (!userId) return res.status(401).json({ error: 'Not logged in' });
  const peerId = userId === 1 ? 2 : 1;
  const messages = db.prepare(`SELECT * FROM messages WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?) ORDER BY created_at ASC`).all(userId, peerId, peerId, userId);
  res.json(messages);
});

app.post('/api/messages/:id/view', (req, res) => {
  const userId = tokens[req.cookies.token];
  if (!userId) return res.status(401).json({ error: 'Not logged in' });
  
  const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(req.params.id);
  if (!msg || msg.image_view_once !== 1) return res.status(404).json({ error: 'Not found' });
  
  db.prepare('UPDATE messages SET image_viewed = 1 WHERE id = ?').run(req.params.id);
  
  if (userSockets[msg.sender_id]) {
    userSockets[msg.sender_id].emit('image_viewed', { id: msg.id });
  }
  
  res.json({ image_data: msg.image_data });
});

app.delete('/api/messages/:id', (req, res) => {
  const userId = tokens[req.cookies.token];
  if (!userId) return res.status(401).json({ error: 'Not logged in' });
  db.prepare('DELETE FROM messages WHERE id = ? AND sender_id = ?').run(req.params.id, userId);
  io.emit('message_deleted', { id: parseInt(req.params.id) });
  res.json({ success: true });
});

app.post('/api/clear-chat', (req, res) => {
  const userId = tokens[req.cookies.token];
  if (!userId) return res.status(401).json({ error: 'Not logged in' });
  const peerId = userId === 1 ? 2 : 1;
  db.prepare('DELETE FROM messages WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?)').run(userId, peerId, peerId, userId);
  io.emit('chat_cleared');
  res.json({ success: true });
});

app.get('/api/public-settings', (req, res) => {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const settings = {};
  rows.forEach(r => { settings[r.key] = r.value; });
  res.json(settings);
});

app.post('/api/admin/login', (req, res) => {
  const { pin } = req.body;
  const adminPin = db.prepare('SELECT value FROM settings WHERE key = ?').get('admin_pin')?.value || '9999';
  if (pin === adminPin) {
    const token = Math.random().toString(36).substring(2) + Math.random().toString(36).substring(2);
    tokens[token] = 'admin';
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.cookie('admin_token', token, { httpOnly: false, sameSite: 'lax', path: '/' });
    res.json({ success: true });
  } else {
    res.status(401).json({ error: 'رمز المسؤول غير صحيح' });
  }
});

app.post('/api/admin/logout', (req, res) => {
  delete tokens[req.cookies.admin_token];
  res.clearCookie('admin_token');
  res.json({ success: true });
});

app.get('/api/admin/data', (req, res) => {
  if (tokens[req.cookies.admin_token] !== 'admin') return res.status(401).json({ error: 'Unauthorized' });
  const users = db.prepare('SELECT id, name, pin FROM users').all();
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const settings = {};
  rows.forEach(r => { settings[r.key] = r.value; });
  res.json({ users, settings });
});

app.post('/api/admin/users', (req, res) => {
  if (tokens[req.cookies.admin_token] !== 'admin') return res.status(401).json({ error: 'Unauthorized' });
  const { users } = req.body;
  const stmt = db.prepare('UPDATE users SET name = ?, pin = ? WHERE id = ?');
  users.forEach(u => stmt.run(u.name, u.pin, u.id));
  res.json({ success: true });
});

app.post('/api/admin/settings', (req, res) => {
  if (tokens[req.cookies.admin_token] !== 'admin') return res.status(401).json({ error: 'Unauthorized' });
  const { settings } = req.body;
  const stmt = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  for (const [key, value] of Object.entries(settings)) {
    stmt.run(key, value);
  }
  res.json({ success: true });
});

io.use((socket, next) => {
  const userId = tokens[socket.handshake.auth.token];
  if (!userId) return next(new Error('Authentication error'));
  socket.userId = userId;
  next();
});

io.on('connection', (socket) => {
  const userId = socket.userId;
  const peerId = userId === 1 ? 2 : 1;
  userSockets[userId] = socket;
  
  const dreamCatcher = db.prepare('SELECT * FROM dream_catcher WHERE user_id = ?').all(userId);
  const mood = db.prepare('SELECT temperature FROM mood WHERE user_id = ?').get(userId);
  const pillowScore = db.prepare('SELECT user_id, score FROM pillow_fight').all();
  
  socket.emit('init_states', {
    dreamCatcher,
    moodTemperature: mood?.temperature || 50,
    pillowFightScore: pillowScore.reduce((acc, p) => { acc[p.user_id] = p.score; return acc; }, {})
  });
  
  if (userSockets[peerId]) userSockets[peerId].emit('presence', { userId, online: true });
  socket.emit('presence', { userId: peerId, online: !!userSockets[peerId] });
  
  socket.on('message', (data) => {
    const result = db.prepare(`INSERT INTO messages (sender_id, receiver_id, content, type, image_data, image_view_once) VALUES (?, ?, ?, ?, ?, ?)`).run(userId, peerId, data.content || '', data.type || 'text', data.image_data || null, data.image_view_once || 0);
    const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(result.lastInsertRowid);
    if (userSockets[peerId]) userSockets[peerId].emit('message', msg);
    socket.emit('message', msg);
  });
  
  socket.on('mark_delivered', (msgId) => {
    db.prepare('UPDATE messages SET delivered_at = CURRENT_TIMESTAMP WHERE id = ?').run(msgId);
    const sender = db.prepare('SELECT sender_id FROM messages WHERE id = ?').get(msgId);
    if (sender && userSockets[sender.sender_id]) userSockets[sender.sender_id].emit('status_update', { id: msgId, status: 'delivered' });
  });
  
  socket.on('mark_seen', (msgId) => {
    db.prepare('UPDATE messages SET seen_at = CURRENT_TIMESTAMP WHERE id = ?').run(msgId);
    const sender = db.prepare('SELECT sender_id FROM messages WHERE id = ?').get(msgId);
    if (sender && userSockets[sender.sender_id]) userSockets[sender.sender_id].emit('status_update', { id: msgId, status: 'seen' });
  });
  
  socket.on('edit_message', (data) => {
    db.prepare('UPDATE messages SET content = ? WHERE id = ? AND sender_id = ?').run(data.content, data.id, userId);
    if (userSockets[peerId]) userSockets[peerId].emit('message_edited', { id: data.id, content: data.content });
  });
  
  socket.on('reaction', (data) => {
    const msg = db.prepare('SELECT reactions FROM messages WHERE id = ?').get(data.msgId);
    if (!msg) return;
    let reactions = {}; try { reactions = JSON.parse(msg.reactions); } catch {}
    if (!reactions[data.emoji]) reactions[data.emoji] = [];
    if (!reactions[data.emoji].includes(userId)) reactions[data.emoji].push(userId);
    db.prepare('UPDATE messages SET reactions = ? WHERE id = ?').run(JSON.stringify(reactions), data.msgId);
    if (userSockets[peerId]) userSockets[peerId].emit('reaction_update', { msgId: data.msgId, reactions });
    socket.emit('reaction_update', { msgId: data.msgId, reactions });
  });
  
  socket.on('toggle_reaction', (data) => {
    const msg = db.prepare('SELECT reactions FROM messages WHERE id = ?').get(data.msgId);
    if (!msg) return;
    let reactions = {}; try { reactions = JSON.parse(msg.reactions); } catch {}
    if (!reactions[data.emoji]) reactions[data.emoji] = [];
    const idx = reactions[data.emoji].indexOf(userId);
    if (idx > -1) reactions[data.emoji].splice(idx, 1); else reactions[data.emoji].push(userId);
    db.prepare('UPDATE messages SET reactions = ? WHERE id = ?').run(JSON.stringify(reactions), data.msgId);
    if (userSockets[peerId]) userSockets[peerId].emit('reaction_update', { msgId: data.msgId, reactions });
    socket.emit('reaction_update', { msgId: data.msgId, reactions });
  });
  
  socket.on('typing', (isTyping) => { if (userSockets[peerId]) userSockets[peerId].emit('typing', { userId, isTyping }); });
  socket.on('send_sleep_notice', (data) => {
    const user = db.prepare('SELECT name FROM users WHERE id = ?').get(userId);
    if (userSockets[peerId]) userSockets[peerId].emit('receive_sleep_notice', { fromName: user.name, funnyMessage: data.funnyMessage, durationMin: data.durationMin });
  });
  socket.on('send_blanket', () => {
    const user = db.prepare('SELECT name FROM users WHERE id = ?').get(userId);
    if (userSockets[peerId]) userSockets[peerId].emit('receive_blanket', { from: user.name });
  });
  socket.on('send_kiss', () => { if (userSockets[peerId]) userSockets[peerId].emit('receive_kiss', { from: userId }); });
  
  socket.on('pillow_fight_throw', () => {
    const peerScore = db.prepare('SELECT score FROM pillow_fight WHERE user_id = ?').get(peerId);
    const newScore = (peerScore?.score || 0) + 1;
    db.prepare('UPDATE pillow_fight SET score = ? WHERE user_id = ?').run(newScore, peerId);
    if (userSockets[peerId]) {
      const p1 = db.prepare('SELECT score FROM pillow_fight WHERE user_id = 1').get().score;
      const p2 = db.prepare('SELECT score FROM pillow_fight WHERE user_id = 2').get().score;
      userSockets[peerId].emit('pillow_fight_hit', { score: { 1: p1, 2: p2 } });
    }
  });
  
  socket.on('send_heartbeat', () => { if (userSockets[peerId]) userSockets[peerId].emit('receive_heartbeat', { from: userId }); });
  socket.on('shake_nudge', () => { if (userSockets[peerId]) userSockets[peerId].emit('receive_nudge', { from: userId }); });
  socket.on('starlight_wish', () => { if (userSockets[peerId]) userSockets[peerId].emit('receive_wish', { from: userId }); });
  socket.on('mood_update', (data) => {
    db.prepare('INSERT OR REPLACE INTO mood (user_id, temperature) VALUES (?, ?)').run(userId, data.temperature);
    if (userSockets[peerId]) userSockets[peerId].emit('mood_update', { temperature: data.temperature });
  });
  
  socket.on('request_camera_view', () => { if (userSockets[peerId]) userSockets[peerId].emit('start_streaming_camera'); });
  socket.on('stop_camera_view', () => { if (userSockets[peerId]) userSockets[peerId].emit('stop_streaming_camera'); });
  socket.on('flip_partner_camera', () => { if (userSockets[peerId]) userSockets[peerId].emit('flip_my_camera'); });
  socket.on('camera_frame', (data) => { if (userSockets[peerId]) userSockets[peerId].emit('receive_camera_frame', { imageData: data.imageData }); });
  
  socket.on('wake_up', () => {
    const dreams = db.prepare('SELECT COUNT(*) as count FROM dream_catcher WHERE user_id = ?').get(userId);
    db.prepare('DELETE FROM dream_catcher WHERE user_id = ?').run(userId);
    socket.emit('dreams_released', { count: dreams.count });
  });
  
  socket.on('disconnect', () => {
    delete userSockets[userId];
    if (userSockets[peerId]) userSockets[peerId].emit('presence', { userId, online: false });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('🌙 Server running at http://localhost:3000');
  console.log('🔑 Default Admin PIN: 9999');
});
