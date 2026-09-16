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

// ---------- tiny JSON-file "database" ----------
const DB_FILE = path.join(__dirname, 'db.json');
let db = { users: [], chats: [], messages: [] };
if (fs.existsSync(DB_FILE)) db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
function saveDb() { fs.writeFileSync(DB_FILE, JSON.stringify(db)); }
const uid = () => crypto.randomBytes(12).toString('hex');

// ---------- upload: files saved AS IS, no compression ----------
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);
const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => cb(null, Date.now() + '_' + crypto.randomBytes(6).toString('hex') + path.extname(file.originalname))
});
const upload = multer({ storage, limits: { fileSize: 500 * 1024 * 1024 } }); // 500 MB

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOAD_DIR)); // original quality files

// ---------- auth helpers ----------
function sign(user) { return jwt.sign({ id: user.id, phone: user.phone }, JWT_SECRET, { expiresIn: '30d' }); }
function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Нет токена' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Токен недействителен' }); }
}
const publicUser = u => ({ id: u.id, name: u.name, phone: u.phone, avatar: u.avatar || null });

// ---------- AUTH ----------
app.post('/api/register', async (req, res) => {
  const { phone, password, name } = req.body || {};
  if (!/^\+?[0-9]{10,15}$/.test(phone || '')) return res.status(400).json({ error: 'Некорректный номер телефона' });
  if (!password || password.length < 6) return res.status(400).json({ error: 'Пароль минимум 6 символов' });
  if (!name) return res.status(400).json({ error: 'Укажите имя' });
  if (db.users.find(u => u.phone === phone)) return res.status(409).json({ error: 'Такой номер уже зарегистрирован' });
  const user = { id: uid(), phone, name, passHash: await bcrypt.hash(password, 10), avatar: null, createdAt: Date.now() };
  db.users.push(user); saveDb();
  res.json({ token: sign(user), user: publicUser(user) });
});

app.post('/api/login', async (req, res) => {
  const { phone, password } = req.body || {};
  const user = db.users.find(u => u.phone === phone);
  if (!user || !(await bcrypt.compare(password || '', user.passHash)))
    return res.status(401).json({ error: 'Неверный номер или пароль' });
  res.json({ token: sign(user), user: publicUser(user) });
});

app.get('/api/me', auth, (req, res) => {
  const u = db.users.find(x => x.id === req.user.id);
  res.json({ user: publicUser(u) });
});

app.get('/api/users', auth, (req, res) => {
  res.json({ users: db.users.filter(u => u.id !== req.user.id).map(publicUser) });
});

// ---------- AVATAR ----------
app.post('/api/avatar', auth, upload.single('file'), (req, res) => {
  if (!req.file || !req.file.mimetype.startsWith('image/'))
    return res.status(400).json({ error: 'Нужен файл изображения' });
  const user = db.users.find(u => u.id === req.user.id);
  user.avatar = '/uploads/' + req.file.filename;
  saveDb();
  io.emit('user_updated', publicUser(user));
  res.json({ user: publicUser(user) });
});

// ---------- CHATS (private + groups) ----------
app.post('/api/chats', auth, (req, res) => {
  const { userId, name, memberIds } = req.body || {};
  if (userId) { // private chat
    let chat = db.chats.find(c => c.type === 'private' &&
      c.members.includes(req.user.id) && c.members.includes(userId));
    if (!chat) {
      chat = { id: uid(), type: 'private', members: [req.user.id, userId], createdAt: Date.now() };
      db.chats.push(chat); saveDb();
    }
    return res.json({ chat });
  }
  // group
  const members = [...new Set([req.user.id, ...(memberIds || [])])];
  if (!name || members.length < 2) return res.status(400).json({ error: 'Нужно название и участники' });
  const chat = { id: uid(), type: 'group', name, members, createdAt: Date.now() };
  db.chats.push(chat); saveDb();
  res.json({ chat });
});

app.get('/api/chats', auth, (req, res) => {
  const chats = db.chats.filter(c => c.members.includes(req.user.id)).map(c => ({
    ...c,
    members: c.members.map(id => publicUser(db.users.find(u => u.id === id) || { id })),
    lastMessage: db.messages.filter(m => m.chatId === c.id).slice(-1)[0] || null
  }));
  res.json({ chats: chats.sort((a, b) => (b.lastMessage?.ts || b.createdAt) - (a.lastMessage?.ts || a.createdAt)) });
});

app.get('/api/chats/:id/messages', auth, (req, res) => {
  const chat = db.chats.find(c => c.id === req.params.id);
  if (!chat || !chat.members.includes(req.user.id)) return res.status(403).json({ error: 'Нет доступа' });
  res.json({ messages: db.messages.filter(m => m.chatId === chat.id).slice(-200) });
});

// ---------- MESSAGE EDIT / DELETE ----------
app.patch('/api/messages/:id', auth, (req, res) => {
  const msg = db.messages.find(m => m.id === req.params.id);
  if (!msg) return res.status(404).json({ error: 'Сообщение не найдено' });
  if (msg.senderId !== req.user.id) return res.status(403).json({ error: 'Можно редактировать только свои сообщения' });
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

// ---------- UPLOAD (original quality: photo/video/audio/voice) ----------
app.post('/api/upload', auth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });
  const mime = req.file.mimetype;
  const type = mime.startsWith('image/') ? 'image'
    : mime.startsWith('video/') ? 'video'
    : mime.startsWith('audio/') ? 'audio' : 'file';
  res.json({ url: '/uploads/' + req.file.filename, type, name: req.file.originalname, size: req.file.size });
});

// ---------- SOCKET.IO: real-time messages ----------
io.use((socket, next) => {
  try {
    socket.user = jwt.verify(socket.handshake.auth.token, JWT_SECRET);
    next();
  } catch { next(new Error('auth error')); }
});

io.on('connection', (socket) => {
  db.chats.filter(c => c.members.includes(socket.user.id)).forEach(c => socket.join(c.id));

  socket.on('send_message', (payload, ack) => {
    const { chatId, text, file } = payload || {};
    const chat = db.chats.find(c => c.id === chatId);
    if (!chat || !chat.members.includes(socket.user.id))
      return ack?.({ error: 'Нет доступа к чату' });
    if (!text && !file) return ack?.({ error: 'Пустое сообщение' });
    const msg = {
      id: uid(), chatId, senderId: socket.user.id,
      type: file ? file.type : 'text',
      text: text || '', file: file || null, ts: Date.now()
    };
    db.messages.push(msg); saveDb();
    io.to(chatId).emit('new_message', msg);
    ack?.({ ok: true, message: msg });
  });

  socket.on('typing', ({ chatId }) => {
    socket.to(chatId).emit('typing', { chatId, userId: socket.user.id, name: socket.user.phone });
  });
});

server.listen(PORT, () => console.log(`Мессенджер запущен: http://localhost:${PORT}`));
