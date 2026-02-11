const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('./database');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-me-in-production';
const MAX_UPLOAD_MB = parseInt(process.env.MAX_UPLOAD_SIZE || '10', 10);
const TURN_URL = process.env.TURN_URL || '';
const TURN_USERNAME = process.env.TURN_USERNAME || '';
const TURN_PASSWORD = process.env.TURN_PASSWORD || '';

// Ensure upload directory
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const app = express();
app.set('trust proxy', 1); // Trust reverse proxy (Pangolin/Traefik/nginx)
const server = http.createServer(app);

// Session middleware (shared with Socket.IO)
const sessionMiddleware = session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    secure: process.env.NODE_ENV === 'production', // HTTPS only in production (needed behind Pangolin)
    sameSite: 'lax',
  }
});

app.use(express.json());
app.use(cookieParser());
app.use(sessionMiddleware);
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/uploads', express.static(UPLOAD_DIR));

// File upload config
const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|webp|svg|bmp/;
    const ext = allowed.test(path.extname(file.originalname).toLowerCase());
    const mime = allowed.test(file.mimetype.split('/')[1]);
    cb(null, ext || mime);
  }
});

// Auth middleware
function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  next();
}

// ============ REST API ============

// Auth routes
app.post('/api/auth/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  if (username.length < 2 || username.length > 32) return res.status(400).json({ error: 'Username must be 2-32 characters' });
  if (password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });

  const user = await db.createUser(username.trim(), password);
  if (!user) return res.status(409).json({ error: 'Username already taken' });

  req.session.userId = user.id;
  res.json({ id: user.id, username: user.username });
});

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  const user = await db.authenticateUser(username, password);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });

  req.session.userId = user.id;
  res.json(user);
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  const user = db.getUser(req.session.userId);
  if (!user) return res.status(401).json({ error: 'User not found' });
  res.json(user);
});

// ICE/TURN config for voice chat
app.get('/api/ice-config', requireAuth, (req, res) => {
  const iceServers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ];
  if (TURN_URL) {
    iceServers.push({
      urls: TURN_URL,
      username: TURN_USERNAME,
      credential: TURN_PASSWORD,
    });
    // Also add turns (TLS) variant if available
    if (TURN_URL.startsWith('turn:')) {
      iceServers.push({
        urls: TURN_URL.replace('turn:', 'turns:').replace(':3478', ':5349'),
        username: TURN_USERNAME,
        credential: TURN_PASSWORD,
      });
    }
  }
  res.json({ iceServers });
});

// Server routes
app.get('/api/servers', requireAuth, (req, res) => {
  res.json(db.getUserServers(req.session.userId));
});

app.post('/api/servers', requireAuth, (req, res) => {
  const { name } = req.body;
  if (!name || name.length < 1 || name.length > 100) return res.status(400).json({ error: 'Invalid server name' });
  const s = db.createServer(name.trim(), req.session.userId);
  res.json(s);
});

app.post('/api/servers/:id/join', requireAuth, (req, res) => {
  const s = db.joinServer(req.params.id, req.session.userId);
  if (!s) return res.status(404).json({ error: 'Server not found' });
  res.json(s);
});

app.post('/api/servers/:id/leave', requireAuth, (req, res) => {
  db.leaveServer(req.params.id, req.session.userId);
  res.json({ ok: true });
});

app.delete('/api/servers/:id', requireAuth, (req, res) => {
  db.deleteServer(req.params.id, req.session.userId);
  res.json({ ok: true });
});

app.get('/api/servers/:id/members', requireAuth, (req, res) => {
  res.json(db.getServerMembers(req.params.id));
});

// Channel routes
app.get('/api/servers/:serverId/channels', requireAuth, (req, res) => {
  res.json(db.getServerChannels(req.params.serverId));
});

app.post('/api/servers/:serverId/channels', requireAuth, (req, res) => {
  const { name, type } = req.body;
  if (!name) return res.status(400).json({ error: 'Channel name required' });
  const ch = db.createChannel(req.params.serverId, name.trim(), type || 'text');
  res.json(ch);
});

// Message routes
app.get('/api/channels/:channelId/messages', requireAuth, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '50'), 100);
  const offset = parseInt(req.query.offset || '0');
  res.json(db.getMessages(req.params.channelId, limit, offset));
});

// Upload
app.post('/api/upload', requireAuth, upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image provided' });
  res.json({ url: `/uploads/${req.file.filename}` });
});

// Users
app.get('/api/users', requireAuth, (req, res) => {
  res.json(db.getAllUsers());
});

// DM routes
app.get('/api/dms/partners', requireAuth, (req, res) => {
  res.json(db.getDMPartners(req.session.userId));
});

app.get('/api/dms/:userId', requireAuth, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '50'), 100);
  const offset = parseInt(req.query.offset || '0');
  res.json(db.getDMs(req.session.userId, req.params.userId, limit, offset));
});

// All server list (for browsing/joining)
app.get('/api/servers/browse/all', requireAuth, (req, res) => {
  // Return all servers (simple discovery)
  const allServers = db.getUserServers(req.session.userId);
  res.json(allServers);
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// ============ SOCKET.IO ============

const io = new Server(server, {
  maxHttpBufferSize: MAX_UPLOAD_MB * 1024 * 1024
});

// Share session with Socket.IO
io.use((socket, next) => {
  sessionMiddleware(socket.request, {}, next);
});

// Track voice channel participants: { channelId: Set<{ userId, username, socketId }> }
const voiceRooms = new Map();
// Track user sockets: { userId: socketId }
const userSockets = new Map();

io.on('connection', (socket) => {
  const userId = socket.request.session?.userId;
  if (!userId) {
    socket.disconnect();
    return;
  }

  const user = db.getUser(userId);
  if (!user) {
    socket.disconnect();
    return;
  }

  userSockets.set(userId, socket.id);
  db.setUserStatus(userId, 'online');
  io.emit('user:status', { userId, status: 'online' });

  // Join user's server rooms for broadcasts
  const servers = db.getUserServers(userId);
  for (const s of servers) {
    socket.join(`server:${s.id}`);
  }

  // --- Text messaging ---
  socket.on('channel:join', (channelId) => {
    socket.join(`channel:${channelId}`);
  });

  socket.on('channel:leave', (channelId) => {
    socket.leave(`channel:${channelId}`);
  });

  socket.on('message:send', (data) => {
    const { channelId, content, imageUrl } = data;
    if (!channelId || (!content && !imageUrl)) return;

    const channel = db.getChannel(channelId);
    if (!channel) return;
    if (!db.isServerMember(channel.server_id, userId)) return;

    const sanitizedContent = content ? content.substring(0, 2000) : null;
    const msg = db.createMessage(channelId, userId, sanitizedContent, imageUrl || null);
    io.to(`channel:${channelId}`).emit('message:new', msg);
  });

  socket.on('message:delete', (data) => {
    const { messageId, channelId } = data;
    db.deleteMessage(messageId, userId);
    io.to(`channel:${channelId}`).emit('message:deleted', { messageId, channelId });
  });

  // --- Direct Messages ---
  socket.on('dm:send', (data) => {
    const { receiverId, content, imageUrl } = data;
    if (!receiverId || (!content && !imageUrl)) return;

    const sanitizedContent = content ? content.substring(0, 2000) : null;
    const msg = db.createDM(userId, receiverId, sanitizedContent, imageUrl || null);

    // Send to both sender and receiver
    const receiverSocketId = userSockets.get(receiverId);
    socket.emit('dm:new', msg);
    if (receiverSocketId) {
      io.to(receiverSocketId).emit('dm:new', msg);
    }
  });

  // --- Voice Chat (WebRTC signaling) ---
  socket.on('voice:join', (channelId) => {
    if (!voiceRooms.has(channelId)) {
      voiceRooms.set(channelId, new Map());
    }

    const room = voiceRooms.get(channelId);
    const participant = { userId, username: user.username, socketId: socket.id };

    // Notify existing participants about the new user
    for (const [existingSocketId, existingUser] of room) {
      io.to(existingSocketId).emit('voice:user-joined', participant);
      // Tell the new user about existing participants
      socket.emit('voice:user-joined', {
        userId: existingUser.userId,
        username: existingUser.username,
        socketId: existingSocketId
      });
    }

    room.set(socket.id, participant);
    socket.join(`voice:${channelId}`);
    socket.voiceChannel = channelId;

    // Broadcast updated voice state
    const channel = db.getChannel(channelId);
    if (channel) {
      io.to(`server:${channel.server_id}`).emit('voice:state', {
        channelId,
        participants: Array.from(room.values())
      });
    }
  });

  socket.on('voice:leave', (channelId) => {
    leaveVoiceChannel(socket, channelId || socket.voiceChannel);
  });

  socket.on('voice:offer', ({ to, offer }) => {
    io.to(to).emit('voice:offer', { from: socket.id, offer });
  });

  socket.on('voice:answer', ({ to, answer }) => {
    io.to(to).emit('voice:answer', { from: socket.id, answer });
  });

  socket.on('voice:ice-candidate', ({ to, candidate }) => {
    io.to(to).emit('voice:ice-candidate', { from: socket.id, candidate });
  });

  // --- Server management via socket ---
  socket.on('server:join', (serverId) => {
    socket.join(`server:${serverId}`);
  });

  // --- Typing indicator ---
  socket.on('typing:start', (channelId) => {
    socket.to(`channel:${channelId}`).emit('typing:start', {
      userId, username: user.username, channelId
    });
  });

  socket.on('typing:stop', (channelId) => {
    socket.to(`channel:${channelId}`).emit('typing:stop', { userId, channelId });
  });

  // --- Disconnect ---
  socket.on('disconnect', () => {
    userSockets.delete(userId);
    db.setUserStatus(userId, 'offline');
    io.emit('user:status', { userId, status: 'offline' });

    if (socket.voiceChannel) {
      leaveVoiceChannel(socket, socket.voiceChannel);
    }
  });
});

function leaveVoiceChannel(socket, channelId) {
  if (!channelId) return;
  const room = voiceRooms.get(channelId);
  if (!room) return;

  room.delete(socket.id);
  socket.leave(`voice:${channelId}`);
  delete socket.voiceChannel;

  const userId = socket.request.session?.userId;

  io.to(`voice:${channelId}`).emit('voice:user-left', { socketId: socket.id, userId });

  const channel = db.getChannel(channelId);
  if (channel) {
    io.to(`server:${channel.server_id}`).emit('voice:state', {
      channelId,
      participants: Array.from(room.values())
    });
  }

  if (room.size === 0) voiceRooms.delete(channelId);
}

server.listen(PORT, HOST, () => {
  console.log(`Discord Clone running at http://${HOST}:${PORT}`);
});
