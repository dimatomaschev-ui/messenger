const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'change_me_to_long_random_string';

// ---------- database ----------
const DB_FILE = path.join(__dirname, 'db.json');
let db = { users: [], chats: [], messages: [] };
if (fs.existsSync(DB_FILE)) db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
function saveDb() { fs.writeFileSync(DB_FILE, JSON.stringify(db)); }
const uid = () => crypto.randomBytes(12).toString('hex');

// ---------- online tracking ----------
const online = new Set();
function broadcastPresence(userId) {
  const u = db.users.find(x => x.id === userId);
  if (!u) return;
  io.emit('presence', { userId, online: online.has(userId), lastSeen: u.lastSeen || null });
}

// ---------- upload ----------
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);
const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => cb(null, Date.now() + '_' + crypto.randomBytes(6).toString('hex') + path.extname(file.originalname))
});
const upload = multer({ storage, limits: { fileSize: 500 * 1024 * 1024 } });

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOAD_DIR));

// ---------- helpers ----------
function sign(user) { return jwt.sign({ id: user.id, phone: user.phone }, JWT_SECRET, { expiresIn: '30d' }); }
function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Нет токена' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Токен недействителен' }); }
}
const defaultPrivacy = () => ({ showPhone: 'all', showUsername: true });
function publicUser(u, viewerId) {
  if (!u || !u.id) return { id: u?.id };
  const privacy = u.privacy || defaultPrivacy();
  const isSelf = viewerId && viewerId === u.id;
  const phone = (isSelf || privacy.showPhone === 'all') ? u.phone : null;
  return {
    id: u.id, name: u.name,
    username: privacy.showUsername || isSelf ? u.username || null : null,
    phone, avatar: u.avatar || null,
    publicKey: u.publicKey || null,
    online: online.has(u.id),
    lastSeen: u.lastSeen || null
  };
}
const validUsername = s => /^[a-zA-Z0-9_]{4,20}$/.test(s || '');

// ---------- AUTH ----------
app.post('/api/register', async (req, res) => {
  const { phone, password, name, username } = req.body || {};
  if (!/^\+?[0-9]{10,15}$/.test(phone || '')) return res.status(400).json({ error: 'Некорректный номер телефона' });
  if (!password || password.length < 6) return res.status(400).json({ error: 'Пароль минимум 6 символов' });
  if (!name) return res.status(400).json({ error: 'Укажите имя' });
  if (username && !validUsername(username)) return res.status(400).json({ error: 'Юзернейм: 4–20 символов, латиница, цифры и _' });
  if (db.users.find(u => u.phone === phone)) return res.status(409).json({ error: 'Такой номер уже зарегистрирован' });
  if (username && db.users.find(u => u.username === username.toLowerCase())) return res.status(409).json({ error: 'Этот юзернейм занят' });
  const user = {
    id: uid(), phone, name,
    username: username ? username.toLowerCase() : null,
    passHash: await bcrypt.hash(password, 10),
    avatar: null, privacy: defaultPrivacy(), publicKey: null,
    lastSeen: null, createdAt: Date.now()
  };
  db.users.push(user); saveDb();
  res.json({ token: sign(user), user: publicUser(user, user.id) });
});

app.post('/api/login', async (req, res) => {
  const { phone, password } = req.body || {};
  const user = db.users.find(u => u.phone === phone);
  if (!user || !(await bcrypt.compare(password || '', user.passHash)))
    return res.status(401).json({ error: 'Неверный номер или пароль' });
  res.json({ token: sign(user), user: publicUser(user, user.id) });
});

app.get('/api/me', auth, (req, res) => {
  const u = db.users.find(x => x.id === req.user.id);
  res.json({ user: publicUser(u, u.id), privacy: u.privacy || defaultPrivacy() });
});

// ---------- PROFILE / PRIVACY / E2E KEYS ----------
app.patch('/api/profile', auth, (req, res) => {
  const u = db.users.find(x => x.id === req.user.id);
  const { name, username, privacy, publicKey } = req.body || {};
  if (name !== undefined) {
    if (!name.trim()) return res.status(400).json({ error: 'Имя не может быть пустым' });
    u.name = name.trim();
  }
  if (username !== undefined) {
    if (username && !validUsername(username)) return res.status(400).json({ error: 'Юзернейм: 4–20 символов, латиница, цифры и _' });
    const un = username ? username.toLowerCase() : null;
    if (un && db.users.find(x => x.username === un && x.id !== u.id)) return res.status(409).json({ error: 'Этот юзернейм занят' });
    u.username = un;
  }
  if (publicKey && typeof publicKey === 'object' && publicKey.x && publicKey.y && publicKey.kty === 'EC') {
    u.publicKey = publicKey;
  }
  if (privacy && typeof privacy === 'object') {
    u.privacy = {
      showPhone: ['all', 'nobody'].includes(privacy.showPhone) ? privacy.showPhone : (u.privacy || defaultPrivacy()).showPhone,
      showUsername: privacy.showUsername !== false
    };
  }
  saveDb();
  io.emit('user_updated', publicUser(u, null));
  res.json({ user: publicUser(u, u.id), privacy: u.privacy });
});

app.get('/api/users', auth, (req, res) => {
  const q = (req.query.q || '').toLowerCase();
  let users = db.users.filter(u => u.id !== req.user.id);
  if (q) users = users.filter(u =>
    u.name?.toLowerCase().includes(q) ||
    u.username?.toLowerCase().includes(q) ||
    u.phone?.includes(q));
  res.json({ users: users.map(u => publicUser(u, req.user.id)) });
});

// ---------- AVATAR ----------
app.post('/api/avatar', auth, upload.single('file'), (req, res) => {
  if (!req.file || !req.file.mimetype.startsWith('image/'))
    return res.status(400).json({ error: 'Нужен файл изображения' });
  const user = db.users.find(u => u.id === req.user.id);
  user.avatar = '/uploads/' + req.file.filename;
  saveDb();
  io.emit('user_updated', publicUser(user, null));
  res.json({ user: publicUser(user, req.user.id) });
});

// ---------- CHATS ----------
app.post('/api/chats', auth, (req, res) => {
  const { userId, name, memberIds } = req.body || {};
  if (userId) {
    let chat = db.chats.find(c => c.type === 'private' &&
      c.members.includes(req.user.id) && c.members.includes(userId));
    if (!chat) {
      chat = { id: uid(), type: 'private', members: [req.user.id, userId], secret: false, createdAt: Date.now() };
      db.chats.push(chat); saveDb();
    }
    return res.json({ chat });
  }
  const members = [...new Set([req.user.id, ...(memberIds || [])])];
  if (!name || members.length < 2) return res.status(400).json({ error: 'Нужно название и участники' });
  const chat = { id: uid(), type: 'group', name, members, createdAt: Date.now() };
  db.chats.push(chat); saveDb();
  res.json({ chat });
});

// add members to existing group
app.post('/api/chats/:id/members', auth, (req, res) => {
  const chat = db.chats.find(c => c.id === req.params.id);
  if (!chat || chat.type !== 'group') return res.status(404).json({ error: 'Группа не найдена' });
  if (!chat.members.includes(req.user.id)) return res.status(403).json({ error: 'Нет доступа' });
  const add = (req.body?.userIds || []).filter(id => db.users.find(u => u.id === id) && !chat.members.includes(id));
  chat.members.push(...add);
  saveDb();
  // make added users' sockets join the room
  for (const [, s] of io.sockets.sockets) {
    if (add.includes(s.user?.id)) s.join(chat.id);
  }
  io.to(chat.id).emit('group_updated', chat.id);
  res.json({ chat });
});

// toggle secret mode (E2E) — private chats only
app.patch('/api/chats/:id/secret', auth, (req, res) => {
  const chat = db.chats.find(c => c.id === req.params.id);
  if (!chat || !chat.members.includes(req.user.id)) return res.status(403).json({ error: 'Нет доступа' });
  if (chat.type !== 'private') return res.status(400).json({ error: 'Секретные чаты — только личные' });
  chat.secret = !!req.body?.secret;
  saveDb();
  io.to(chat.id).emit('chat_secret', { chatId: chat.id, secret: chat.secret });
  res.json({ chat });
});

app.get('/api/chats', auth, (req, res) => {
  const chats = db.chats.filter(c => c.members.includes(req.user.id)).map(c => ({
    ...c,
    members: c.members.map(id => publicUser(db.users.find(u => u.id === id), req.user.id)),
    lastMessage: db.messages.filter(m => m.chatId === c.id).slice(-1)[0] || null
  }));
  res.json({ chats: chats.sort((a, b) => (b.lastMessage?.ts || b.createdAt) - (a.lastMessage?.ts || a.createdAt)) });
});

app.get('/api/chats/:id/messages', auth, (req, res) => {
  const chat = db.chats.find(c => c.id === req.params.id);
  if (!chat || !chat.members.includes(req.user.id)) return res.status(403).json({ error: 'Нет доступа' });
  res.json({ messages: db.messages.filter(m => m.chatId === chat.id).slice(-200) });
});

// ---------- MESSAGES ----------
app.patch('/api/messages/:id', auth, (req, res) => {
  const msg = db.messages.find(m => m.id === req.params.id);
  if (!msg) return res.status(404).json({ error: 'Сообщение не найдено' });
  if (msg.senderId !== req.user.id) return res.status(403).json({ error: 'Можно редактировать только свои сообщения' });
  if (msg.encrypted) return res.status(400).json({ error: 'Зашифрованные сообщения нельзя редактировать' });
  const text = (req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Пустое сообщение' });
  msg.text = text; msg.edited = true; saveDb();
  io.to(msg.chatId).emit('message_updated', msg);
  res.json({ message: msg });
});

app.delete('/api/messages/:id', auth, (req, res) => {
  const i = db.messages.findIndex(m => m.id === req.params.id);
  if (i === -1) return res.status(404).json({ error: 'Сообщение не найдено' });
  const msg = db.messages[i];
  if (msg.senderId !== req.user.id) return res.status(403).json({ error: 'Можно удалять только свои сообщения' });
  db.messages.splice(i, 1); saveDb();
  io.to(msg.chatId).emit('message_deleted', { id: msg.id, chatId: msg.chatId });
  res.json({ ok: true });
});

// ---------- UPLOAD ----------
app.post('/api/upload', auth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });
  const mime = req.file.mimetype;
  const type = mime.startsWith('image/') ? 'image'
    : mime.startsWith('video/') ? 'video'
    : mime.startsWith('audio/') ? 'audio' : 'file';
  res.json({ url: '/uploads/' + req.file.filename, type, name: req.file.originalname, size: req.file.size });
});

// ---------- SOCKET.IO ----------
io.use((socket, next) => {
  try {
    socket.user = jwt.verify(socket.handshake.auth.token, JWT_SECRET);
    next();
  } catch { next(new Error('auth error')); }
});

io.on('connection', (socket) => {
  db.chats.filter(c => c.members.includes(socket.user.id)).forEach(c => socket.join(c.id));

  online.add(socket.user.id);
  broadcastPresence(socket.user.id);

  socket.on('send_message', (payload, ack) => {
    const { chatId, text, file, encrypted } = payload || {};
    const chat = db.chats.find(c => c.id === chatId);
    if (!chat || !chat.members.includes(socket.user.id)) return ack?.({ error: 'Нет доступа к чату' });
    if (!text && !file) return ack?.({ error: 'Пустое сообщение' });
    if (encrypted && file) return ack?.({ error: 'Файлы в секретном чате не шифруются — отправьте без текста или отключите 🔒' });
    const msg = {
      id: uid(), chatId, senderId: socket.user.id,
      type: file ? file.type : 'text',
      text: text || '', encrypted: !!encrypted,
      file: file || null, ts: Date.now()
    };
    db.messages.push(msg); saveDb();
    io.to(chatId).emit('new_message', msg);
    ack?.({ ok: true, message: msg });
  });

  socket.on('typing', ({ chatId }) => {
    socket.to(chatId).emit('typing', { chatId, userId: socket.user.id });
  });

  socket.on('disconnect', () => {
    const stillOnline = [...io.sockets.sockets].some(([, s]) => s.user?.id === socket.user.id);
    if (!stillOnline) {
      online.delete(socket.user.id);
      const u = db.users.find(x => x.id === socket.user.id);
      if (u) { u.lastSeen = Date.now(); saveDb(); }
      broadcastPresence(socket.user.id);
    }
  });
});

server.listen(PORT, () => console.log(`Мессенджер запущен: http://localhost:${PORT}`));
