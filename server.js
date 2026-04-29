require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const { Client, GatewayIntentBits } = require('discord.js');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: 'wintech-siam-2026',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 86400000 }
}));

const UNIVERSE_ID    = process.env.UNIVERSE_ID;
const ROBLOX_API_KEY = process.env.ROBLOX_API_KEY;
const WEBHOOK_SECRET = 'siam-wintech-2026';
const DISCORD_WAR_START = process.env.DISCORD_WAR_START || '';
const DISCORD_WAR_END   = process.env.DISCORD_WAR_END || '';

async function sendDiscordWebhook(url, embed) {
  if (!url) return;
  try {
    await axios.post(url, { embeds: [embed] }, { headers: { 'Content-Type': 'application/json' } });
  } catch(e) { console.error('Webhook error:', e.message); }
}
const USERS_FILE     = './users.json';

// SSE
const sseClients = new Set();
let currentPlayers = [];
let currentPrices = [];
let currentPricesTime = null;
let currentPricesLabel = '';
let currentPricesRound = 0;
let currentPricesTotalRounds = 0;

function broadcast(data) {
  const msg = 'data: ' + JSON.stringify(data) + '\n\n';
  sseClients.forEach(function(res) {
    try { res.write(msg); } catch(e) { sseClients.delete(res); }
  });
}

const HISTORY_FILE = './history.json';

// โหลด history เก่า
function loadHistory() {
  if (!fs.existsSync(HISTORY_FILE)) {
    const def = { events: [] };
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(def));
    return def;
  }
  try { return JSON.parse(fs.readFileSync(HISTORY_FILE)); }
  catch { return { events: [] }; }
}
let historyData = loadHistory();
const eventLog = historyData.events.slice(0, 200); // recent for live feed

let saveTimer = null;
function scheduleSaveHistory() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    try {
      fs.writeFileSync(HISTORY_FILE, JSON.stringify({ events: historyData.events.slice(0, 10000) }));
    } catch(e) { console.error('save history error:', e.message); }
    saveTimer = null;
  }, 5000);
}

function getThaiTime() {
  return new Date().toLocaleTimeString('th-TH', {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    timeZone: 'Asia/Bangkok'
  });
}
function getThaiDate() {
  return new Date().toLocaleDateString('th-TH', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    timeZone: 'Asia/Bangkok'
  });
}
function getThaiTimestamp() {
  // คืน ISO ของเวลาไทย (UTC+7)
  return new Date(Date.now() + 7*60*60*1000).toISOString();
}
function addEvent(event) {
  event.id = Date.now();
  event.timestamp = new Date().toISOString();
  event.thaiTimestamp = getThaiTimestamp();
  eventLog.unshift(event);
  if (eventLog.length > 200) eventLog.pop();
  // เก็บประวัติถาวร
  historyData.events.unshift(event);
  if (historyData.events.length > 10000) historyData.events.pop();
  scheduleSaveHistory();
  broadcast(event);
}

const ROLES = {
  owner:  { label: 'เจ้าของแมพ', color: '#FFD700', icon: '👑' },
  board:  { label: 'บอร์ดบริหาร', color: '#E8A020', icon: '🏛️' },
  admin:  { label: 'Admin', color: '#C4873A', icon: '⚔️' },
  member: { label: 'Member', color: '#8B6914', icon: '🛡️' },
};

function getUsers() {
  if (!fs.existsSync(USERS_FILE)) {
    const def = {
      owner: { password: '987654321', role: 'owner', displayName: 'เจ้าของแมพ' }
    };
    fs.writeFileSync(USERS_FILE, JSON.stringify(def, null, 2));
    return def;
  }
  return JSON.parse(fs.readFileSync(USERS_FILE));
}
function saveUsers(u) { fs.writeFileSync(USERS_FILE, JSON.stringify(u, null, 2)); }

const onlineUsers = new Map();
const auth      = (req, res, next) => req.session.user ? next() : res.status(401).json({ ok: false, msg: 'กรุณาเข้าสู่ระบบ' });
const adminOnly = (req, res, next) => ['owner','board','admin'].includes(req.session.user?.role) ? next() : res.status(403).json({ ok: false, msg: 'ไม่มีสิทธิ์' }); // roles: member < admin < board < owner
const ownerOnly = (req, res, next) => req.session.user?.role === 'owner' ? next() : res.status(403).json({ ok: false, msg: 'เฉพาะเจ้าของแมพ' });

async function getRobloxStats() {
  try {
    const [gameRes, serverRes] = await Promise.all([
      axios.get('https://games.roblox.com/v1/games?universeIds=' + UNIVERSE_ID),
      axios.get('https://games.roblox.com/v1/games/' + UNIVERSE_ID + '/servers/Public?limit=100')
    ]);
    const game = gameRes.data.data[0];
    return { playing: game?.playing || 0, servers: serverRes.data.data.length, visits: game?.visits || 0 };
  } catch { return { playing: 0, servers: 0, visits: 0 }; }
}

async function sendToRoblox(topic, payload) {
  await axios.post(
    'https://apis.roblox.com/messaging-service/v1/universes/' + UNIVERSE_ID + '/topics/' + topic,
    { message: JSON.stringify(payload) },
    { headers: { 'x-api-key': ROBLOX_API_KEY, 'Content-Type': 'application/json' } }
  );
}

// Resolve username to userId via Roblox API
// Permission helper
function getPermissions(role) {
  return {
    canSeeAll: ['owner', 'board'].includes(role),
    canAdmin: ['owner', 'board', 'admin'].includes(role),
    canManageUsers: role === 'owner',
    isOwner: role === 'owner',
    isBoard: role === 'board',
  };
}

async function resolveUserId(input) {
  if (/^\d+$/.test(input)) return input; // already userId
  try {
    const res = await axios.post('https://users.roblox.com/v1/usernames/users',
      { usernames: [input], excludeBannedUsers: false },
      { headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    if (res.data.data && res.data.data.length > 0) return String(res.data.data[0].id);
  } catch(e) { console.error('Resolve userId error:', e.message); }
  return null;
}

// Discord Bot
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
client.once('clientReady', () => console.log('✅ Discord: ' + client.user.tag));
client.login(process.env.DISCORD_TOKEN);

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/dashboard', (req, res) => {
  if (!req.session.user) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.get('/login', (req, res) => {
  res.redirect('/');
});

// API Auth
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const users = getUsers();
  const user = users[username];
  if (!user || user.password !== password) return res.json({ ok: false, msg: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
  req.session.user = { username, role: user.role, displayName: user.displayName || username };
  onlineUsers.set(username, { username, role: user.role, displayName: user.displayName || username, loginTime: new Date().toISOString() });
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  if (req.session.user) onlineUsers.delete(req.session.user.username);
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', (req, res) => {
  if (!req.session.user) return res.json({ ok: false });
  const perms = getPermissions(req.session.user.role);
  res.json({ ok: true, ...req.session.user, ...perms });
});

// SSE
app.get('/events', auth, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.write('data: ' + JSON.stringify({ type: 'connected' }) + '\n\n');
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

// Roblox Webhook
app.post('/roblox-event', (req, res) => {
  const data = req.body;
  if (data.secret !== WEBHOOK_SECRET) return res.status(403).json({ ok: false });
  res.json({ ok: true });

  const time = getThaiTime();
  const dateStr = getThaiDate();
  const t = data.type;

  if (t === 'join') addEvent({ type: 'join', icon: '📥', color: '#22AA55', text: data.player + ' เข้าแมพ', time });
  else if (t === 'leave') addEvent({ type: 'leave', icon: '📤', color: '#888888', text: data.player + ' ออกแมพ', time });
  else if (t === 'kill') addEvent({ type: 'kill', icon: '⚔️', color: '#FF4444', text: data.killer + ' ⚔️ ' + data.victim, time });
  else if (t === 'death') addEvent({ type: 'death', icon: '💀', color: '#888888', text: data.victim + ' ตายเอง', time });
  else if (t === 'chat') addEvent({ type: 'chat', icon: '💬', color: '#D4A017', text: data.player + ': ' + data.message, time });
  else if (t === 'playerlist') { currentPlayers = data.players || []; broadcast({ type: 'playerlist' }); }
  else if (t === 'givemoney') addEvent({ type: 'givemoney', icon: '💰', color: '#FFD700', text: 'เสกเงิน ' + data.player + ' +฿' + (data.amount || 0).toLocaleString(), time });
  else if (t === 'teamchange') {
    addEvent({ type: 'teamchange', icon: '🏳️', color: '#42A5F5', text: data.player + ' ย้ายไปทีม ' + data.team, time: data.timeStr || time, player: data.player, team: data.team, dateStr: data.dateStr });
    broadcast({ type: 'teamchange', player: data.player, team: data.team, timeStr: data.timeStr, dateStr: data.dateStr });
  }
  else if (t === 'rankchange') {
    addEvent({ type: 'rankchange', icon: '🏆', color: '#FFD700', text: data.player + ' เลื่อนยศ ระดับ ' + data.oldRank + ' → ' + data.newRank + ' (' + data.roleName + ')', time, player: data.player, oldRank: data.oldRank, newRank: data.newRank, roleName: data.roleName });
    broadcast({ type: 'rankchange', player: data.player, oldRank: data.oldRank, newRank: data.newRank, roleName: data.roleName, time });
  }
  else if (t === 'moneychange') {
    var sign = data.change > 0 ? '+' : '';
    addEvent({ type: 'moneychange', icon: '💰', color: data.change > 0 ? '#4CAF50' : '#F44336',
      text: data.player + ' เงิน ' + sign + data.change.toLocaleString() + ' อัฐ (รวม: ฿' + data.newMoney.toLocaleString() + ')',
      time, player: data.player, oldMoney: data.oldMoney, newMoney: data.newMoney, change: data.change });
  }
  else if (t === 'adminaction') {
    var icons = { clearinventory:'🗑️', setmoney:'💰', fillfoodwater:'🍖' };
    var icon = icons[data.action] || '⚙️';
    addEvent({ type: 'adminaction', icon: icon, color: '#9C27B0',
      text: icon + ' ' + data.player + ' — ' + data.text, time });
  }
  else if (t === 'fetter') {
    addEvent({ type: 'fetter', icon: data.action === 'lock' ? '⛓️' : '🔓', color: data.action === 'lock' ? '#FF5722' : '#4CAF50',
      text: (data.action === 'lock' ? '⛓️ ล็อคโซ่ตรวน ' : '🔓 ปลดโซ่ตรวน ') + data.player, time, player: data.player });
  }
  else if (t === 'prices') {
    currentPrices = data.prices || [];
    currentPricesTime = new Date().toISOString();
    currentPricesLabel = data.label || '';
    currentPricesRound = data.round || 0;
    currentPricesTotalRounds = data.total || 0;
    broadcast({ type: 'prices', prices: currentPrices, time, label: currentPricesLabel, round: currentPricesRound, total: currentPricesTotalRounds });
  }
});

// API
app.get('/api/stats',   auth, async (req, res) => res.json(await getRobloxStats()));
app.get('/api/online',  auth, (req, res) => res.json(Array.from(onlineUsers.values())));
app.get('/api/events',  auth, (req, res) => res.json(eventLog));
app.get('/api/players', auth, (req, res) => res.json(currentPlayers));
app.get('/api/transferlog', auth, (req, res) => {
  res.json(historyData.events.filter(e => e.type === 'transfer').slice(0, 1000));
});

// History API - filter by type, date range
app.get('/api/history/:type', auth, (req, res) => {
  const type = req.params.type;
  const { from, to, limit } = req.query;
  let events = historyData.events;

  // Filter by type(s)
  const types = type.split(',');
  if (!types.includes('all')) {
    events = events.filter(e => types.includes(e.type));
  }

  // Filter by date range
  if (from) {
    const fromTime = new Date(from).getTime();
    events = events.filter(e => new Date(e.timestamp).getTime() >= fromTime);
  }
  if (to) {
    const toTime = new Date(to).getTime() + 86400000; // +1 day
    events = events.filter(e => new Date(e.timestamp).getTime() <= toTime);
  }

  const lim = parseInt(limit) || 500;
  res.json(events.slice(0, lim));
});
app.get('/api/moneylog', auth, (req, res) => res.json(eventLog.filter(e => e.type === 'moneychange').slice(0, 50)));
app.get('/api/prices', auth, (req, res) => res.json({ prices: currentPrices, updatedAt: currentPricesTime, label: currentPricesLabel, round: currentPricesRound, total: currentPricesTotalRounds }));

app.get('/api/users', auth, adminOnly, (req, res) => {
  const users = getUsers();
  const isOwner = req.session.user.role === 'owner';
  res.json(Object.entries(users).map(([username, d]) => ({
    username,
    displayName: d.displayName || username,
    role: d.role,
    online: onlineUsers.has(username),
    // เจ้าของแมพเห็นรหัสผ่านและรายละเอียดทั้งหมด
    password: isOwner ? d.password : undefined,
    createdAt: d.createdAt || null,
  })));
});

app.post('/api/users/add', auth, ownerOnly, (req, res) => {
  const { username, password, displayName, role } = req.body;
  if (!username || !password) return res.json({ ok: false, msg: 'กรุณากรอกให้ครบ' });
  const users = getUsers();
  if (users[username]) return res.json({ ok: false, msg: 'มีผู้ใช้นี้แล้ว' });
  users[username] = { password, displayName: displayName || username, role: role || 'member' };
  saveUsers(users);
  res.json({ ok: true, msg: 'เพิ่ม ' + (displayName || username) + ' สำเร็จ' });
});

app.post('/api/users/edit', auth, ownerOnly, (req, res) => {
  const { username, displayName, password, role } = req.body;
  const users = getUsers();
  if (!users[username]) return res.json({ ok: false, msg: 'ไม่พบผู้ใช้' });
  const validRoles = ['member', 'admin', 'board', 'owner'];
  if (role && !validRoles.includes(role)) return res.json({ ok: false, msg: 'ยศไม่ถูกต้อง' });
  if (displayName) users[username].displayName = displayName;
  if (password && password.length >= 1) users[username].password = password;
  if (role) users[username].role = role;
  saveUsers(users);
  // อัปเดต session ถ้า online
  if (onlineUsers.has(username)) {
    const u = onlineUsers.get(username);
    if (role) u.role = role;
    if (displayName) u.displayName = displayName;
  }
  res.json({ ok: true, msg: 'แก้ไข ' + username + ' สำเร็จ' });
});

app.post('/api/users/role', auth, ownerOnly, (req, res) => {
  const { username, role } = req.body;
  const validRoles = ['member', 'admin', 'board', 'owner'];
  if (!username || !validRoles.includes(role)) return res.json({ ok: false, msg: 'ข้อมูลไม่ถูกต้อง' });
  const users = getUsers();
  if (!users[username]) return res.json({ ok: false, msg: 'ไม่พบผู้ใช้' });
  users[username].role = role;
  saveUsers(users);
  // Update session if online
  onlineUsers.forEach((u, k) => {
    if (k === username) { u.role = role; }
  });
  res.json({ ok: true, msg: 'เปลี่ยนยศ ' + username + ' เป็น ' + role + ' สำเร็จ' });
});

app.post('/api/users/remove', auth, ownerOnly, (req, res) => {
  const { username } = req.body;
  const users = getUsers();
  if (!users[username]) return res.json({ ok: false, msg: 'ไม่พบผู้ใช้' });
  const ownerCount = Object.values(users).filter(u => u.role === 'owner').length;
  if (users[username].role === 'owner' && ownerCount <= 1) return res.json({ ok: false, msg: 'ต้องมีเจ้าของแมพอย่างน้อย 1 คน' });
  delete users[username];
  saveUsers(users);
  onlineUsers.delete(username);
  res.json({ ok: true, msg: 'ลบสำเร็จ' });
});

app.post('/api/ban', auth, adminOnly, async (req, res) => {
  const { userId: input, reason } = req.body;
  if (!input) return res.json({ ok: false, msg: 'กรุณาใส่ชื่อหรือ User ID' });
  const userId = await resolveUserId(input);
  if (!userId) return res.json({ ok: false, msg: 'ไม่พบผู้ใช้: ' + input });
  try {
    await sendToRoblox('BanSystem', { action: 'ban', userId, reason: reason || 'ไม่ระบุ' });
    res.json({ ok: true, msg: 'ขับไล่ ' + input + ' สำเร็จ' });
  } catch (e) { res.json({ ok: false, msg: e.message }); }
});

app.post('/api/unban', auth, adminOnly, async (req, res) => {
  const { userId: input } = req.body;
  if (!input) return res.json({ ok: false, msg: 'กรุณาใส่ชื่อหรือ User ID' });
  const userId = await resolveUserId(input);
  if (!userId) return res.json({ ok: false, msg: 'ไม่พบผู้ใช้: ' + input });
  try {
    await sendToRoblox('BanSystem', { action: 'unban', userId, reason: '' });
    res.json({ ok: true, msg: 'อภัยโทษ ' + input + ' สำเร็จ' });
  } catch (e) { res.json({ ok: false, msg: e.message }); }
});

app.post('/api/kick', auth, adminOnly, async (req, res) => {
  const { userId: input, reason } = req.body;
  if (!input) return res.json({ ok: false, msg: 'กรุณาใส่ชื่อหรือ User ID' });
  const userId = await resolveUserId(input);
  if (!userId) return res.json({ ok: false, msg: 'ไม่พบผู้ใช้: ' + input });
  try {
    await sendToRoblox('BanSystem', { action: 'kick', userId, reason: reason || 'ไม่ระบุ' });
    res.json({ ok: true, msg: 'แตะ ' + input + ' สำเร็จ' });
  } catch (e) { res.json({ ok: false, msg: e.message }); }
});

// Reset Server
// Reset Data API
app.post('/api/resetdata', auth, ownerOnly, async (req, res) => {
  const { userId, resetType, step5confirm } = req.body;
  if (!userId || !resetType) return res.json({ ok: false, msg: 'กรุณากรอกให้ครบ' });
  if (step5confirm !== 'CONFIRM_RESET') return res.json({ ok: false, msg: 'รหัสยืนยันไม่ถูกต้อง' });
  const resolvedId = await resolveUserId(userId);
  if (!resolvedId) return res.json({ ok: false, msg: 'ไม่พบผู้ใช้: ' + userId });
  try {
    await sendToRoblox('ResetData', { userId: resolvedId, resetType });
    const msg = resetType === 'money' ? 'รีเงิน' : 'รีข้อมูลทั้งหมด';
    addEvent({ type: 'adminaction', icon: '🗑️', color: '#FF5722',
      text: msg + ' userId=' + resolvedId + ' โดย ' + req.session.user.displayName,
      time: getThaiTime(), dateStr: getThaiDate() });
    res.json({ ok: true, msg: msg + ' สำเร็จ' });
  } catch(e) { res.json({ ok: false, msg: e.message }); }
});

app.post('/api/resetserver', auth, adminOnly, async (req, res) => {
  const { confirmedBy, reason, password } = req.body;
  if (!confirmedBy || !reason || !password) return res.json({ ok: false, msg: 'กรุณากรอกให้ครบ' });
  if (password !== '123456') return res.json({ ok: false, msg: 'รหัสผ่านไม่ถูกต้อง' });
  try {
    await sendToRoblox('ResetServer', { action: 'kickall', confirmedBy, reason });
    addEvent({ type: 'resetserver', icon: '🔄', color: '#FF5722',
      text: 'รีเซิร์ฟเวอร์โดย ' + confirmedBy + ' — เหตุผล: ' + reason,
      time: new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    });
    res.json({ ok: true, msg: 'รีเซิร์ฟเวอร์สำเร็จ Kick ทุกคนแล้ว' });
  } catch(e) { res.json({ ok: false, msg: e.message }); }
});

// Register
app.post('/api/register', (req, res) => {
  const { username, password, displayName } = req.body;
  if (!username || !password) return res.json({ ok: false, msg: 'กรุณากรอกให้ครบ' });
  if (username.length < 3) return res.json({ ok: false, msg: 'ชื่อผู้ใช้ต้องมีอย่างน้อย 3 ตัวอักษร' });
  if (password.length < 6) return res.json({ ok: false, msg: 'รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร' });
  const users = getUsers();
  if (users[username]) return res.json({ ok: false, msg: 'ชื่อผู้ใช้นี้มีอยู่แล้ว' });
  users[username] = { password, displayName: displayName || username, role: 'member', createdAt: new Date().toISOString() };
  saveUsers(users);
  res.json({ ok: true, msg: 'สมัครสมาชิกสำเร็จ' });
});

app.post('/api/admin/cmd', auth, adminOnly, async (req, res) => {
  const { userId, cmd, amount } = req.body;
  if (!userId || !cmd) return res.json({ ok: false, msg: 'กรุณากรอกให้ครบ' });
  const resolvedId = await resolveUserId(userId);
  if (!resolvedId) return res.json({ ok: false, msg: 'ไม่พบผู้ใช้: ' + userId });
  try {
    await sendToRoblox('AdminCommands', { cmd, userId: resolvedId, amount: amount || 0 });
    const msgs = { clearinventory: 'ลบของสำเร็จ', setmoney: 'ปรับเงินสำเร็จ', fillfoodwater: 'เติมอาหาร/น้ำสำเร็จ' };
    res.json({ ok: true, msg: msgs[cmd] || 'สำเร็จ' });
  } catch(e) { res.json({ ok: false, msg: e.message }); }
});

app.post('/api/fetter', auth, adminOnly, async (req, res) => {
  const { username, action } = req.body;
  if (!username || !action) return res.json({ ok: false, msg: 'กรุณากรอกให้ครบ' });
  try {
    await sendToRoblox('FetterSystem', { username, action });
    res.json({ ok: true, msg: (action === 'lock' ? '⛓️ ล็อคโซ่ตรวน ' : '🔓 ปลดโซ่ตรวน ') + username + ' สำเร็จ' });
  } catch(e) { res.json({ ok: false, msg: e.message }); }
});

app.post('/api/givemoney', auth, adminOnly, async (req, res) => {
  const { userId, amount } = req.body;
  if (!userId || !amount) return res.json({ ok: false, msg: 'กรุณากรอกให้ครบ' });
  try {
    await sendToRoblox('GiveMoney', { userId, amount: parseInt(amount) });
    res.json({ ok: true, msg: 'เสกเงิน ฿' + parseInt(amount).toLocaleString() + ' สำเร็จ' });
  } catch (e) { res.json({ ok: false, msg: e.message }); }
});

const WAR_FILE = './wars.json';

function getWars() {
  if (!fs.existsSync(WAR_FILE)) { fs.writeFileSync(WAR_FILE, '[]'); return []; }
  return JSON.parse(fs.readFileSync(WAR_FILE));
}
function saveWars(w) { fs.writeFileSync(WAR_FILE, JSON.stringify(w, null, 2)); }

function getActiveWar() {
  return getWars().find(w => w.status === 'active') || null;
}

// GET สงครามปัจจุบัน
app.get('/api/war/current', auth, (req, res) => {
  res.json(getActiveWar() || { status: 'none' });
});

// GET ประวัติสงคราม
app.get('/api/war/history', auth, (req, res) => {
  res.json(getWars().filter(w => w.status !== 'active').slice(0, 20));
});

// POST เปิดสงคราม
app.post('/api/war/start', auth, adminOnly, async (req, res) => {
  const { attackTeam, defendTeam, confirmedBy } = req.body;
  if (!attackTeam || !defendTeam || !confirmedBy) return res.json({ ok: false, msg: 'กรุณากรอกให้ครบ' });
  if (attackTeam === defendTeam) return res.json({ ok: false, msg: 'ทีมไม่สามารถรบกับตัวเองได้' });
  if (getActiveWar()) return res.json({ ok: false, msg: 'มีสงครามที่กำลังดำเนินอยู่แล้ว' });

  const now = new Date();
  const timeStr = now.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Asia/Bangkok' });
  const dateStr = now.toLocaleDateString('th-TH', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Asia/Bangkok' });

  const war = {
    id: Date.now(),
    attackTeam, defendTeam, confirmedBy,
    startTime: now.toISOString(),
    timeStr, dateStr,
    status: 'active',
    endTime: null, endedBy: null, winner: null, loser: null
  };

  const wars = getWars();
  wars.unshift(war);
  saveWars(wars);

  // ประกาศในแมพ
  try {
    await sendToRoblox('WarSystem', { action: 'start', attackTeam, defendTeam, timeStr, dateStr });
  } catch(e) { console.error('War announce error:', e.message); }

  // แจ้ง Discord
  await sendDiscordWebhook(DISCORD_WAR_START, {
    title: '⚔️ ประกาศสงคราม!',
    description: '**' + attackTeam + '** เปิดสงครามใส่ **' + defendTeam + '**',
    color: 0xFF6B00,
    fields: [
      { name: '🏳️ ผู้บุก', value: attackTeam, inline: true },
      { name: '🛡️ ผู้ถูกบุก', value: defendTeam, inline: true },
      { name: '👤 ผู้ประกาศ', value: confirmedBy, inline: true },
      { name: '🕐 เวลา', value: timeStr + ' น.', inline: true },
      { name: '📅 วันที่', value: dateStr, inline: true },
    ],
    footer: { text: 'อาณาจักรสยาม ค่าย — บริษัทวินเทค' },
    timestamp: new Date().toISOString(),
  });

  // เพิ่ม event ใน feed
  addEvent({
    type: 'war_start', icon: '⚔️', color: '#FF6B00',
    text: 'สงคราม! ' + attackTeam + ' ปะทะ ' + defendTeam + ' (โดย ' + confirmedBy + ')',
    time: timeStr
  });

  res.json({ ok: true, msg: 'ประกาศสงครามสำเร็จ', war });
});

// POST ยกเลิกสงคราม
app.post('/api/war/end', auth, adminOnly, async (req, res) => {
  const { confirmedBy, winner, loser } = req.body;
  if (!confirmedBy || !winner || !loser) return res.json({ ok: false, msg: 'กรุณากรอกให้ครบ' });

  const wars = getWars();
  const activeIdx = wars.findIndex(w => w.status === 'active');
  if (activeIdx === -1) return res.json({ ok: false, msg: 'ไม่มีสงครามที่กำลังดำเนินอยู่' });

  const now = new Date();
  const timeStr = now.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Asia/Bangkok' });
  
  wars[activeIdx].status = 'ended';
  wars[activeIdx].endTime = now.toISOString();
  wars[activeIdx].endedBy = confirmedBy;
  wars[activeIdx].winner = winner;
  wars[activeIdx].loser = loser;
  saveWars(wars);

  // ประกาศในแมพ
  try {
    await sendToRoblox('WarSystem', { action: 'end', winner, loser, timeStr, endedBy: confirmedBy });
  } catch(e) { console.error('War end error:', e.message); }

  // แจ้ง Discord
  var w = wars[activeIdx];
  await sendDiscordWebhook(DISCORD_WAR_END, {
    title: '🏆 สงครามสิ้นสุดแล้ว!',
    description: 'สงคราม **' + w.attackTeam + '** ปะทะ **' + w.defendTeam + '** ได้จบลงแล้ว\n**' + winner + '** เป็นผู้ยึด **' + loser + '**',
    color: 0xFFD700,
    fields: [
      { name: '🏆 ผู้ชนะ', value: winner, inline: true },
      { name: '💀 ผู้แพ้', value: loser, inline: true },
      { name: '👤 ผู้ยืนยัน', value: confirmedBy, inline: true },
      { name: '🕐 เวลาเริ่ม', value: w.timeStr + ' น.', inline: true },
      { name: '🕐 เวลาจบ', value: timeStr + ' น.', inline: true },
    ],
    footer: { text: 'อาณาจักรสยาม ค่าย — บริษัทวินเทค' },
    timestamp: new Date().toISOString(),
  });

  // เพิ่ม event
  addEvent({
    type: 'war_end', icon: '🏆', color: '#FFD700',
    text: 'สงครามสิ้นสุด! ' + winner + ' ยึด ' + loser + ' (โดย ' + confirmedBy + ')',
    time: timeStr
  });

  res.json({ ok: true, msg: 'ยกเลิกสงครามสำเร็จ', war: wars[activeIdx] });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('✅ เปิดเว็บที่ port ' + PORT));
