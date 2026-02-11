const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcrypt');
const { v4: uuidv4 } = require('uuid');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'chat.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Initialize schema
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    avatar_color TEXT NOT NULL DEFAULT '#5865f2',
    status TEXT NOT NULL DEFAULT 'offline',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS servers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    owner_id TEXT NOT NULL REFERENCES users(id),
    icon_color TEXT NOT NULL DEFAULT '#5865f2',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS channels (
    id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'text',
    position INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS server_members (
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id),
    role TEXT NOT NULL DEFAULT 'member',
    joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (server_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id),
    content TEXT,
    image_url TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    edited_at DATETIME
  );

  CREATE TABLE IF NOT EXISTS direct_messages (
    id TEXT PRIMARY KEY,
    sender_id TEXT NOT NULL REFERENCES users(id),
    receiver_id TEXT NOT NULL REFERENCES users(id),
    content TEXT,
    image_url TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_dm_users ON direct_messages(sender_id, receiver_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_channels_server ON channels(server_id);
`);

// Prepared statements
const stmts = {
  createUser: db.prepare(
    'INSERT INTO users (id, username, password_hash, avatar_color) VALUES (?, ?, ?, ?)'
  ),
  getUserByUsername: db.prepare('SELECT * FROM users WHERE username = ?'),
  getUserById: db.prepare('SELECT id, username, avatar_color, status FROM users WHERE id = ?'),
  updateUserStatus: db.prepare('UPDATE users SET status = ? WHERE id = ?'),

  createServer: db.prepare(
    'INSERT INTO servers (id, name, owner_id, icon_color) VALUES (?, ?, ?, ?)'
  ),
  getServer: db.prepare('SELECT * FROM servers WHERE id = ?'),
  getUserServers: db.prepare(`
    SELECT s.* FROM servers s
    JOIN server_members sm ON s.id = sm.server_id
    WHERE sm.user_id = ?
    ORDER BY s.created_at
  `),
  deleteServer: db.prepare('DELETE FROM servers WHERE id = ? AND owner_id = ?'),

  addServerMember: db.prepare(
    'INSERT OR IGNORE INTO server_members (server_id, user_id, role) VALUES (?, ?, ?)'
  ),
  removeServerMember: db.prepare(
    'DELETE FROM server_members WHERE server_id = ? AND user_id = ?'
  ),
  getServerMembers: db.prepare(`
    SELECT u.id, u.username, u.avatar_color, u.status, sm.role
    FROM users u JOIN server_members sm ON u.id = sm.user_id
    WHERE sm.server_id = ?
    ORDER BY sm.role DESC, u.username
  `),
  isServerMember: db.prepare(
    'SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?'
  ),

  createChannel: db.prepare(
    'INSERT INTO channels (id, server_id, name, type, position) VALUES (?, ?, ?, ?, ?)'
  ),
  getServerChannels: db.prepare(
    'SELECT * FROM channels WHERE server_id = ? ORDER BY type, position'
  ),
  deleteChannel: db.prepare('DELETE FROM channels WHERE id = ?'),
  getChannel: db.prepare('SELECT * FROM channels WHERE id = ?'),

  createMessage: db.prepare(
    'INSERT INTO messages (id, channel_id, user_id, content, image_url) VALUES (?, ?, ?, ?, ?)'
  ),
  getMessages: db.prepare(`
    SELECT m.*, u.username, u.avatar_color FROM messages m
    JOIN users u ON m.user_id = u.id
    WHERE m.channel_id = ?
    ORDER BY m.created_at DESC
    LIMIT ? OFFSET ?
  `),
  deleteMessage: db.prepare('DELETE FROM messages WHERE id = ? AND user_id = ?'),

  createDM: db.prepare(
    'INSERT INTO direct_messages (id, sender_id, receiver_id, content, image_url) VALUES (?, ?, ?, ?, ?)'
  ),
  getDMs: db.prepare(`
    SELECT dm.*, u.username, u.avatar_color FROM direct_messages dm
    JOIN users u ON dm.sender_id = u.id
    WHERE (dm.sender_id = ? AND dm.receiver_id = ?)
       OR (dm.sender_id = ? AND dm.receiver_id = ?)
    ORDER BY dm.created_at DESC
    LIMIT ? OFFSET ?
  `),
  getDMPartners: db.prepare(`
    SELECT DISTINCT u.id, u.username, u.avatar_color, u.status FROM users u
    WHERE u.id IN (
      SELECT sender_id FROM direct_messages WHERE receiver_id = ?
      UNION
      SELECT receiver_id FROM direct_messages WHERE sender_id = ?
    )
  `),

  getAllUsers: db.prepare('SELECT id, username, avatar_color, status FROM users'),
};

const COLORS = ['#5865f2', '#57f287', '#fee75c', '#eb459e', '#ed4245', '#f47b67', '#e7a0ff'];

function randomColor() {
  return COLORS[Math.floor(Math.random() * COLORS.length)];
}

module.exports = {
  // Auth
  async createUser(username, password) {
    const id = uuidv4();
    const hash = await bcrypt.hash(password, 10);
    try {
      stmts.createUser.run(id, username, hash, randomColor());
      return { id, username };
    } catch (e) {
      if (e.message.includes('UNIQUE')) return null;
      throw e;
    }
  },

  async authenticateUser(username, password) {
    const user = stmts.getUserByUsername.get(username);
    if (!user) return null;
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return null;
    return { id: user.id, username: user.username, avatar_color: user.avatar_color };
  },

  getUser(id) {
    return stmts.getUserById.get(id);
  },

  getAllUsers() {
    return stmts.getAllUsers.all();
  },

  setUserStatus(id, status) {
    stmts.updateUserStatus.run(status, id);
  },

  // Servers
  createServer(name, ownerId) {
    const id = uuidv4();
    const color = randomColor();
    stmts.createServer.run(id, name, ownerId, color);
    stmts.addServerMember.run(id, ownerId, 'owner');
    // Create default channels
    const generalId = uuidv4();
    const voiceId = uuidv4();
    stmts.createChannel.run(generalId, id, 'general', 'text', 0);
    stmts.createChannel.run(voiceId, id, 'General Voice', 'voice', 1);
    return { id, name, owner_id: ownerId, icon_color: color };
  },

  getServer(id) {
    return stmts.getServer.get(id);
  },

  getUserServers(userId) {
    return stmts.getUserServers.all(userId);
  },

  deleteServer(serverId, ownerId) {
    return stmts.deleteServer.run(serverId, ownerId);
  },

  joinServer(serverId, userId) {
    const server = stmts.getServer.get(serverId);
    if (!server) return null;
    stmts.addServerMember.run(serverId, userId, 'member');
    return server;
  },

  leaveServer(serverId, userId) {
    stmts.removeServerMember.run(serverId, userId);
  },

  getServerMembers(serverId) {
    return stmts.getServerMembers.all(serverId);
  },

  isServerMember(serverId, userId) {
    return !!stmts.isServerMember.get(serverId, userId);
  },

  // Channels
  createChannel(serverId, name, type = 'text') {
    const channels = stmts.getServerChannels.all(serverId);
    const id = uuidv4();
    stmts.createChannel.run(id, serverId, name, type, channels.length);
    return { id, server_id: serverId, name, type, position: channels.length };
  },

  getServerChannels(serverId) {
    return stmts.getServerChannels.all(serverId);
  },

  getChannel(id) {
    return stmts.getChannel.get(id);
  },

  deleteChannel(id) {
    stmts.deleteChannel.run(id);
  },

  // Messages
  createMessage(channelId, userId, content, imageUrl = null) {
    const id = uuidv4();
    stmts.createMessage.run(id, channelId, userId, content, imageUrl);
    const user = stmts.getUserById.get(userId);
    return {
      id, channel_id: channelId, user_id: userId, content, image_url: imageUrl,
      created_at: new Date().toISOString(), username: user.username, avatar_color: user.avatar_color
    };
  },

  getMessages(channelId, limit = 50, offset = 0) {
    return stmts.getMessages.all(channelId, limit, offset).reverse();
  },

  deleteMessage(messageId, userId) {
    return stmts.deleteMessage.run(messageId, userId);
  },

  // Direct Messages
  createDM(senderId, receiverId, content, imageUrl = null) {
    const id = uuidv4();
    stmts.createDM.run(id, senderId, receiverId, content, imageUrl);
    const user = stmts.getUserById.get(senderId);
    return {
      id, sender_id: senderId, receiver_id: receiverId, content, image_url: imageUrl,
      created_at: new Date().toISOString(), username: user.username, avatar_color: user.avatar_color
    };
  },

  getDMs(userId1, userId2, limit = 50, offset = 0) {
    return stmts.getDMs.all(userId1, userId2, userId2, userId1, limit, offset).reverse();
  },

  getDMPartners(userId) {
    return stmts.getDMPartners.all(userId, userId);
  },
};
