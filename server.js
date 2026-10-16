// Їдальня табору — сервер. Дані: Upstash Redis (на Vercel) або файл data/db.json (на своєму комп'ютері/сервері)
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const TZ = process.env.CAMP_TZ || 'Europe/Kyiv';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const SESSION_DAYS = 30;

const ROLES = {
  admin: 'Адміністратор',
  head: 'Глава корпусу',
  guide: 'Гід',
  waiter: 'Офіціант',
  cook: 'Кухар',
  cook_assistant: 'Помічник кухаря',
};
const MEALS = ['breakfast', 'lunch', 'afternoon', 'dinner', 'snack'];
const ACTIVE = ['planned', 'seated'];

const DEFAULT_SETTINGS = {
  campName: 'Табір',
  tables: 25,
  seats: 6,
  bigTables: '',   // номери столів, де більше стільців (напр. '1,5,13')
  bigSeats: 7,
  // Схема залу: кожен рядок — колонка столів, числа — позиції рядів зверху вниз (пропуск = прохід).
  // За замовчуванням як у вашій їдальні: ліворуч 6 + прохід + 6, праворуч 13 підряд.
  layout: ['1-6,8-13', '1-13'],
  autoCloseAfter: 20, // хв після кінця прийому їжі заявка закривається автоматично
  remindBefore: 15,   // за скільки хв до приходу стіл підсвічується «накрити зараз»
  meals: {
    breakfast: { label: 'Сніданок', time: '08:30', duration: 30 },
    lunch: { label: 'Обід', time: '13:00', duration: 40 },
    afternoon: { label: 'Полуденок', time: '16:30', duration: 20 },
    dinner: { label: 'Вечеря', time: '19:00', duration: 40 },
    snack: { label: 'Перекус', time: '21:00', duration: 20 },
  },
};

// ---------- сховище ----------
let db;
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { salt, hash };
}
function checkPassword(user, password) {
  const { hash } = hashPassword(password, user.salt);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(user.hash, 'hex'));
}
function uid() { return crypto.randomBytes(8).toString('hex'); }

// ---------- де лежать дані ----------
// Якщо задані змінні Upstash Redis (їх додає Vercel при підключенні бази) — дані в Redis.
// Інакше — у файлі data/db.json, як раніше.
const REDIS_URL = (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/$/, '');
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
const USE_REDIS = !!(REDIS_URL && REDIS_TOKEN);
const SERVERLESS = !!process.env.VERCEL;
const RP = process.env.REDIS_PREFIX || 'camp:';
const DAY_TTL = 70 * 86400; // заявки за день зберігаються 70 днів
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function redis(cmds) {
  const r = await fetch(REDIS_URL + '/pipeline', {
    method: 'POST', headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(cmds),
  });
  if (!r.ok) throw new Error(`Redis HTTP ${r.status}: ${await r.text().catch(() => '')}`);
  const out = await r.json();
  for (const x of out) if (x.error) throw new Error('Redis: ' + x.error);
  return out.map(x => x.result);
}
// блокування, щоб двоє людей одночасно не перезаписали зміни одне одного
async function redisLock() {
  const token = uid();
  for (let i = 0; i < 120; i++) {
    const [ok] = await redis([['SET', RP + 'lock', token, 'NX', 'PX', 8000]]);
    if (ok === 'OK') return token;
    await sleep(50 + Math.random() * 50);
  }
  throw new Error('Не вдалося отримати блокування бази');
}
async function redisUnlock(token) {
  try {
    await redis([['EVAL', "if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end", '1', RP + 'lock', token]]);
  } catch (e) { console.error(e.message); }
}

// Паролі зберігаються двічі: хеш (для входу) і зашифрована копія, яку бачить адміністратор.
// Ключ шифрування: змінна SECRET_KEY (рекомендовано на Vercel), інакше data/secret.key або ключ у Redis.
let SECRET;
async function loadSecret() {
  if (SECRET) return;
  if (process.env.SECRET_KEY) { SECRET = crypto.createHash('sha256').update(process.env.SECRET_KEY).digest(); return; }
  if (USE_REDIS) {
    const [, v] = await redis([['SET', RP + 'secret', crypto.randomBytes(32).toString('hex'), 'NX'], ['GET', RP + 'secret']]);
    SECRET = Buffer.from(v, 'hex'); return;
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const f = path.join(DATA_DIR, 'secret.key');
  if (!fs.existsSync(f)) fs.writeFileSync(f, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  SECRET = Buffer.from(fs.readFileSync(f, 'utf8').trim(), 'hex');
}
function encPw(pw) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', SECRET, iv);
  const ct = Buffer.concat([c.update(String(pw), 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), ct].map(b => b.toString('base64')).join(':');
}
function decPw(v) {
  try {
    const [iv, tag, ct] = v.split(':').map(x => Buffer.from(x, 'base64'));
    const d = crypto.createDecipheriv('aes-256-gcm', SECRET, iv); d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
  } catch { return null; }
}
function setPassword(u, pw) { Object.assign(u, hashPassword(pw), { pwEnc: encPw(pw) }); }

const shiftDate = (d, n) => new Date(Date.parse(d + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);
let dirty = false, loadedDays = new Set(), fileVersion = 1;
function freshDb() {
  const pass = process.env.ADMIN_PASSWORD || 'admin123';
  const { salt, hash } = hashPassword(pass);
  console.log(`\n  Створено першого адміністратора: логін "admin", пароль "${pass}". Змініть пароль після входу!\n`);
  dirty = true;
  return {
    users: [{ id: uid(), login: 'admin', name: 'Адміністратор', role: 'admin', salt, hash, pwEnc: encPw(pass), mustChange: true, createdAt: Date.now() }],
    sessions: {}, requests: [], alerts: [], kitchen: {}, settings: DEFAULT_SETTINGS,
  };
}
// Завантажує дані на початку кожного запиту. З Redis беремо основне + заявки за вчора/сьогодні/завтра (+ потрібні дні).
async function loadDb(extraDays = []) {
  await loadSecret();
  if (USE_REDIS) {
    const today = nowParts().date;
    const days = [...new Set([shiftDate(today, -1), today, shiftDate(today, 1), ...extraDays.filter(d => d && validDate(d))])];
    const res = await redis([['GET', RP + 'core'], ...days.map(d => ['GET', RP + 'day:' + d])]);
    db = res[0] ? JSON.parse(res[0]) : freshDb();
    db.requests = []; db.alerts = [];
    days.forEach((d, i) => { if (res[i + 1]) { const v = JSON.parse(res[i + 1]); db.requests.push(...(v.requests || [])); db.alerts.push(...(v.alerts || [])); } });
    loadedDays = new Set(days);
  } else {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    db = fs.existsSync(DB_FILE) ? JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) : freshDb();
  }
  db.settings = { ...DEFAULT_SETTINGS, ...db.settings, meals: { ...DEFAULT_SETTINGS.meals, ...(db.settings || {}).meals } };
  if (!Array.isArray(db.settings.layout)) db.settings.layout = DEFAULT_SETTINGS.layout;
  delete db.settings.cols;
  db.settings.tables = hallPositions().length;
  for (const k of ['sessions', 'kitchen']) db[k] = db[k] || {};
  for (const k of ['requests', 'alerts', 'users']) db[k] = db[k] || [];
}
function saveDb() { dirty = true; } // реальний запис — перед відповіддю (flushDb)
async function flushDb() {
  if (!dirty) return;
  dirty = false;
  if (USE_REDIS) {
    const { requests, alerts, ...core } = db;
    const days = new Set([...loadedDays, ...requests.map(r => r.date), ...alerts.map(a => a.date)]);
    const cmds = [['SET', RP + 'core', JSON.stringify(core)]];
    for (const d of days) {
      const v = { requests: requests.filter(r => r.date === d), alerts: alerts.filter(a => a.date === d) };
      cmds.push(v.requests.length || v.alerts.length ? ['SET', RP + 'day:' + d, JSON.stringify(v), 'EX', String(DAY_TTL)] : ['DEL', RP + 'day:' + d]);
    }
    cmds.push(['INCR', RP + 'ver']);
    await redis(cmds);
  } else {
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 1));
    fs.renameSync(tmp, DB_FILE);
    fileVersion++;
  }
}

// ---------- час ----------
function nowParts() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date()).map(x => [x.type, x.value]));
  const hour = p.hour === '24' ? '00' : p.hour;
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${hour}:${p.minute}`, min: +hour * 60 + +p.minute };
}
const toMin = t => { const [h, m] = String(t).split(':').map(Number); return h * 60 + m; };
const validTime = t => /^([01]\d|2[0-3]):[0-5]\d$/.test(t);
const validDate = d => /^\d{4}-\d{2}-\d{2}$/.test(d);

function windowOf(r) {
  const start = toMin(r.time);
  let end = start + db.settings.meals[r.meal].duration;
  const now = nowParts();
  // загін, що вже сидить, займає столи, поки не піде
  if (r.status === 'seated' && r.date === now.date) end = Math.max(end, now.min + 5);
  return { start, end };
}
function overlaps(a, b) {
  if (a.date !== b.date) return false;
  const x = windowOf(a), y = windowOf(b);
  return x.start < y.end && y.start < x.end;
}

// ---------- розсадка ----------
// Столи нумеруються по колонках зверху вниз: ліва колонка 1–12, права 13–25.
function parseRows(str) {
  const out = new Set();
  for (const part of String(str || '').split(/[,\s]+/).filter(Boolean)) {
    const m = part.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) continue;
    const a = +m[1], b = +(m[2] || m[1]);
    for (let i = Math.min(a, b); i <= Math.max(a, b) && i <= 60; i++) if (i > 0) out.add(i);
  }
  return [...out].sort((a, b) => a - b);
}
function hallPositions(layout = db.settings.layout) {
  const pos = []; let t = 1;
  layout.forEach((col, c) => parseRows(col).forEach(row => pos.push({ t: t++, col: c, row })));
  return pos;
}
function hallOrder() { return hallPositions().map(p => p.t); }
// сусідні = в одній колонці, у сусідніх рядах (без проходу між ними)
function adjacent(a, b) {
  const pos = hallPositions(), pa = pos[a - 1], pb = pos[b - 1];
  return pa && pb && pa.col === pb.col && Math.abs(pa.row - pb.row) === 1;
}
function busyTables(r) {
  const busy = new Set();
  for (const o of db.requests) {
    if (o.id !== r.id && ACTIVE.includes(o.status) && o.tables.length && overlaps(o, r)) o.tables.forEach(t => busy.add(t));
  }
  return busy;
}
function lastTablesOfSquad(r) {
  const prev = db.requests
    .filter(o => o.id !== r.id && o.squad === r.squad && o.tables.length && o.status !== 'cancelled')
    .sort((a, b) => b.createdAt - a.createdAt)[0];
  return prev ? prev.tables : [];
}
// скільки місць за конкретним столом (деякі столи на 7 стільців)
function seatsOf(t) {
  const big = parseRows(db.settings.bigTables || '');
  return big.includes(t) ? (db.settings.bigSeats || 7) : db.settings.seats;
}
const capacity = tables => tables.reduce((s, t) => s + seatsOf(t), 0);
const hallCapacity = () => capacity(hallOrder());
// ділимо дітей рівномірно, не перевищуючи кількість стільців за кожним столом
function portions(count, tables) {
  const out = tables.map(() => 0);
  for (let k = 0; k < count; k++) {
    let best = -1;
    tables.forEach((t, i) => {
      if (out[i] >= seatsOf(t)) return;
      if (best < 0 || out[i] < out[best] || (out[i] === out[best] && seatsOf(t) > seatsOf(tables[best]))) best = i;
    });
    if (best < 0) break;
    out[best]++;
  }
  return out;
}

function allocate(r) {
  const busy = busyTables(r);
  const order = hallOrder();
  const pref = new Set([...(r.tables || []), ...lastTablesOfSquad(r)]);

  const runs = []; let cur = [];
  for (const t of order) {
    if (busy.has(t)) { if (cur.length) runs.push(cur); cur = []; continue; }
    if (cur.length && !adjacent(cur[cur.length - 1], t)) { runs.push(cur); cur = []; }
    cur.push(t);
  }
  if (cur.length) runs.push(cur);

  // 1) суцільний блок сусідніх столів, де вистачає стільців.
  //    Пріоритет: ті ж столи, що й раніше → найменше порожніх стільців → не дробити вільне місце.
  let best = null, bestScore = -Infinity;
  for (const run of runs) {
    for (let i = 0; i < run.length; i++) {
      let cap = 0, j = i;
      while (j < run.length && cap < r.count) cap += seatsOf(run[j++]);
      if (cap < r.count) break;
      const w = run.slice(i, j);
      const keep = w.filter(t => pref.has(t)).length;
      const middle = i > 0 && j < run.length ? 1 : 0;
      const score = keep * 100 - (cap - r.count) * 3 - w.length * 4 - (run.length - w.length) * 2 - middle;
      if (score > bestScore) { bestScore = score; best = w; }
    }
  }
  let tables, split = false, queued = false;
  if (best) tables = best;
  else if (capacity(runs.flat()) >= r.count) {
    // 2) немає суцільного блоку — беремо з найбільших вільних шматків
    tables = [];
    for (const run of [...runs].sort((a, b) => capacity(b) - capacity(a))) {
      for (const t of run) if (capacity(tables) < r.count) tables.push(t);
    }
    tables.sort((a, b) => order.indexOf(a) - order.indexOf(b));
    split = true;
  } else { tables = []; queued = true; } // 3) місць не вистачає — черга
  const old = r.tableState || {};
  r.tableState = Object.fromEntries(tables.map(t => [t, old[t] || 'waiting']));
  r.tables = tables; r.need = tables.length; r.split = split; r.queued = queued;
  r.portions = tables.length ? portions(r.count, tables) : [];
  return r;
}
function processQueue() {
  let changed = false;
  const queued = db.requests.filter(r => r.queued && ACTIVE.includes(r.status))
    .sort((a, b) => a.date.localeCompare(b.date) || toMin(a.time) - toMin(b.time));
  for (const r of queued) { allocate(r); if (!r.queued) changed = true; }
  return changed;
}

// ---------- сесії ----------
const app = express();
app.use(express.json({ limit: '200kb' }));
app.use(express.static(path.join(__dirname, 'public'))); // на Vercel статику віддає CDN з папки public

// Номер версії даних: телефони питають його кожні кілька секунд і перезавантажують стан, лише коли він змінився.
let verCache = { v: 0, at: 0 };
app.get('/api/version', async (req, res) => {
  try {
    if (!USE_REDIS) return res.json({ v: fileVersion });
    if (Date.now() - verCache.at > 2000) verCache = { v: (await redis([['GET', RP + 'ver']]))[0] || 0, at: Date.now() };
    res.set('Cache-Control', 'no-store').json({ v: verCache.v });
  } catch (e) { res.status(503).json({ error: 'База недоступна' }); }
});

// Кожен запит: завантажити свіжі дані → обробити → зберегти перед відповіддю.
let queue = Promise.resolve();
function localLock() { let rel; const p = new Promise(r => (rel = r)); const prev = queue; queue = queue.then(() => p); return prev.then(() => rel); }
let lastTick = 0;
app.use('/api', async (req, res, next) => {
  const release = await localLock();
  let token = null, finished = false;
  const finish = async () => { if (finished) return; finished = true; if (token) await redisUnlock(token); release(); };
  res.on('finish', finish); res.on('close', finish);
  const days = [req.query.date, req.body && req.body.date];
  try {
    if (USE_REDIS && req.method !== 'GET') token = await redisLock();
    await loadDb(days);
    if (Date.now() - lastTick > 30e3) {
      if (USE_REDIS && !token) { token = await redisLock(); await loadDb(days); }
      lastTick = Date.now(); tick();
    }
  } catch (e) {
    console.error(e);
    finish();
    return res.status(503).json({ error: 'База даних недоступна. Спробуйте ще раз за хвилину.' });
  }
  const json = res.json.bind(res);
  res.json = body => {
    flushDb().then(() => json(body), e => { console.error(e); res.status(500); json({ error: 'Не вдалося зберегти зміни. Спробуйте ще раз.' }); });
    return res;
  };
  if (req.path === '/events') { await flushDb().catch(() => {}); finish(); } // довге з'єднання не тримає чергу
  next();
});

function parseCookies(h = '') {
  return Object.fromEntries(h.split(';').map(c => c.trim().split('=')).filter(x => x[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
}
function auth(req, res, next) {
  const sid = parseCookies(req.headers.cookie).sid;
  const s = sid && db.sessions[sid];
  if (!s || s.exp < Date.now()) return res.status(401).json({ error: 'Потрібно увійти' });
  const user = db.users.find(u => u.id === s.userId);
  if (!user) return res.status(401).json({ error: 'Користувача видалено' });
  req.user = user; req.sid = sid; next();
}
const allow = (...roles) => (req, res, next) =>
  roles.includes(req.user.role) ? next() : res.status(403).json({ error: 'Немає доступу' });
const publicUser = u => ({ id: u.id, login: u.login, name: u.name, role: u.role, squad: u.squad || null, squadSize: u.squadSize || null, zone: u.zone || [], mustChange: !!u.mustChange });

// ---------- живі оновлення (SSE) ----------
const clients = new Set();
function broadcast(what = 'update') {
  for (const res of clients) res.write(`event: ${what}\ndata: ${Date.now()}\n\n`);
}
function commit(what) { saveDb(); broadcast(what); }

app.get('/api/ping', (req, res) => res.json({ ok: true })); // запускає автозакриття заявок
app.get('/api/events', auth, (req, res) => {
  if (SERVERLESS) return res.status(204).end();
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write('retry: 3000\n\n');
  clients.add(res);
  req.on('close', () => clients.delete(res));
});
if (!SERVERLESS) setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 25000);

// ---------- вхід ----------
const failures = new Map();
app.post('/api/login', (req, res) => {
  const ip = req.ip;
  const f = failures.get(ip) || { n: 0, t: Date.now() };
  if (Date.now() - f.t > 10 * 60e3) { f.n = 0; f.t = Date.now(); }
  if (f.n >= 10) return res.status(429).json({ error: 'Забагато спроб. Зачекайте 10 хвилин.' });
  const { login, password } = req.body || {};
  const user = db.users.find(u => u.login.toLowerCase() === String(login || '').trim().toLowerCase());
  if (!user || !checkPassword(user, password || '')) {
    f.n++; failures.set(ip, f);
    return res.status(401).json({ error: 'Невірний логін або пароль' });
  }
  failures.delete(ip);
  const sid = crypto.randomBytes(24).toString('hex');
  db.sessions[sid] = { userId: user.id, exp: Date.now() + SESSION_DAYS * 864e5 };
  for (const [k, s] of Object.entries(db.sessions)) if (s.exp < Date.now()) delete db.sessions[k];
  saveDb();
  res.setHeader('Set-Cookie', `sid=${sid}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`);
  res.json({ user: publicUser(user) });
});
app.post('/api/logout', auth, (req, res) => {
  delete db.sessions[req.sid]; saveDb();
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; Path=/; Max-Age=0');
  res.json({ ok: true });
});
app.get('/api/me', auth, (req, res) => res.json({ user: publicUser(req.user), roles: ROLES, live: !SERVERLESS }));
app.post('/api/me/password', auth, (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  if (!checkPassword(req.user, oldPassword || '')) return res.status(400).json({ error: 'Старий пароль невірний' });
  if (!newPassword || newPassword.length < 4) return res.status(400).json({ error: 'Новий пароль — мінімум 4 символи' });
  setPassword(req.user, newPassword); req.user.mustChange = false;
  saveDb(); res.json({ ok: true });
});

// ---------- стан для екранів ----------
app.get('/api/state', auth, (req, res) => {
  const now = nowParts();
  const date = validDate(req.query.date) ? req.query.date : now.date;
  const requests = db.requests.filter(r => r.date === date && r.status !== 'cancelled');
  const guides = db.users.filter(u => u.role === 'guide').map(u => ({ id: u.id, name: u.name, squad: u.squad, squadSize: u.squadSize }));
  const waiters = db.users.filter(u => u.role === 'waiter').map(u => ({ id: u.id, name: u.name, zone: u.zone || [] }));
  res.json({
    now, date, settings: db.settings, requests,
    alerts: db.alerts.filter(a => a.date === date && !a.resolvedAt),
    kitchen: db.kitchen[date] || {},
    guides, waiters, order: hallOrder(), positions: hallPositions(),
    upcoming: req.user.role === 'guide' ? db.requests.filter(r => r.guideId === req.user.id && r.date > date && r.status !== 'cancelled') : [],
  });
});

// ---------- користувачі ----------
function canManage(actor, role) {
  if (actor.role === 'admin') return true;
  if (actor.role === 'head') return ['guide', 'waiter', 'cook', 'cook_assistant'].includes(role);
  return false;
}
function parseZone(z) {
  if (Array.isArray(z)) return z.map(Number).filter(Boolean);
  const out = new Set();
  for (const part of String(z || '').split(/[,\s]+/).filter(Boolean)) {
    const m = part.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) continue;
    const a = +m[1], b = +(m[2] || m[1]);
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) if (i <= db.settings.tables) out.add(i);
  }
  return [...out].sort((a, b) => a - b);
}
function validateUserFields(body, existing) {
  const role = body.role || existing?.role;
  if (!ROLES[role]) return 'Невідома роль';
  const name = String(body.name ?? existing?.name ?? '').trim();
  if (!name) return 'Вкажіть ім’я';
  if (role === 'guide') {
    const squad = String(body.squad ?? existing?.squad ?? '').trim();
    if (!squad) return 'Для гіда вкажіть номер загону';
  }
  return null;
}
// адмін бачить паролі всіх, глава корпусу — тих, ким керує
const canSeePassword = (actor, u) => actor.role === 'admin' || (actor.role === 'head' && canManage(actor, u.role)) || actor.id === u.id;
app.get('/api/users', auth, allow('admin', 'head'), (req, res) => res.json({
  users: db.users.map(u => ({ ...publicUser(u), password: canSeePassword(req.user, u) ? (u.pwEnc ? decPw(u.pwEnc) : null) : undefined })),
}));
app.post('/api/users', auth, allow('admin', 'head'), (req, res) => {
  const b = req.body || {};
  if (!canManage(req.user, b.role)) return res.status(403).json({ error: 'Ви не можете створювати цю роль' });
  const err = validateUserFields(b); if (err) return res.status(400).json({ error: err });
  const login = String(b.login || '').trim();
  if (!/^[\w.\-а-яіїєґ]{3,32}$/i.test(login)) return res.status(400).json({ error: 'Логін: 3–32 символи (літери, цифри, . _ -)' });
  if (db.users.some(u => u.login.toLowerCase() === login.toLowerCase())) return res.status(400).json({ error: 'Такий логін вже існує' });
  if (!b.password || b.password.length < 4) return res.status(400).json({ error: 'Пароль — мінімум 4 символи' });
  const u = {
    id: uid(), login, name: b.name.trim(), role: b.role, createdAt: Date.now(), createdBy: req.user.id,
    squad: b.role === 'guide' ? String(b.squad).trim() : undefined,
    squadSize: b.role === 'guide' && +b.squadSize > 0 ? +b.squadSize : undefined,
    zone: b.role === 'waiter' ? parseZone(b.zone) : undefined,
  };
  setPassword(u, b.password);
  db.users.push(u); commit();
  res.json({ user: publicUser(u) });
});
app.put('/api/users/:id', auth, allow('admin', 'head'), (req, res) => {
  const u = db.users.find(x => x.id === req.params.id);
  if (!u) return res.status(404).json({ error: 'Не знайдено' });
  const b = req.body || {};
  if (!canManage(req.user, u.role) || (b.role && !canManage(req.user, b.role))) return res.status(403).json({ error: 'Немає прав' });
  const err = validateUserFields(b, u); if (err) return res.status(400).json({ error: err });
  if (b.name) u.name = String(b.name).trim();
  if (b.role) u.role = b.role;
  if (u.role === 'guide') { if (b.squad !== undefined) u.squad = String(b.squad).trim(); if (b.squadSize !== undefined) u.squadSize = +b.squadSize || undefined; }
  if (u.role === 'waiter' && b.zone !== undefined) u.zone = parseZone(b.zone);
  if (b.password) {
    if (b.password.length < 4) return res.status(400).json({ error: 'Пароль — мінімум 4 символи' });
    setPassword(u, b.password);
    for (const [k, s] of Object.entries(db.sessions)) if (s.userId === u.id) delete db.sessions[k];
  }
  commit(); res.json({ user: publicUser(u) });
});
app.delete('/api/users/:id', auth, allow('admin', 'head'), (req, res) => {
  const u = db.users.find(x => x.id === req.params.id);
  if (!u) return res.status(404).json({ error: 'Не знайдено' });
  if (u.id === req.user.id) return res.status(400).json({ error: 'Не можна видалити себе' });
  if (!canManage(req.user, u.role)) return res.status(403).json({ error: 'Немає прав' });
  db.users = db.users.filter(x => x.id !== u.id);
  for (const [k, s] of Object.entries(db.sessions)) if (s.userId === u.id) delete db.sessions[k];
  commit(); res.json({ ok: true });
});

// ---------- налаштування ----------
app.put('/api/settings', auth, allow('admin', 'head'), (req, res) => {
  const b = req.body || {}, s = db.settings;
  if (b.campName !== undefined) s.campName = String(b.campName).slice(0, 60);
  if (Array.isArray(b.layout)) {
    const layout = b.layout.map(x => parseRows(x).join(',')).filter(Boolean).slice(0, 8);
    const n = hallPositions(layout).length;
    if (!n) return res.status(400).json({ error: 'Схема залу порожня' });
    s.layout = b.layout.map(String).filter(x => parseRows(x).length).slice(0, 8);
    s.tables = n;
  }
  if (b.bigTables !== undefined) s.bigTables = parseRows(b.bigTables).filter(t => t <= s.tables).join(',');
  for (const k of ['seats', 'bigSeats', 'autoCloseAfter', 'remindBefore']) {
    if (b[k] !== undefined) { const v = Math.round(+b[k]); if (!(v >= 0 && v <= 200)) return res.status(400).json({ error: `Некоректне значення: ${k}` }); s[k] = v; }
  }
  if (s.seats < 1) return res.status(400).json({ error: 'Місць за столом має бути більше нуля' });
  if (b.meals) for (const m of MEALS) {
    const x = b.meals[m]; if (!x) continue;
    if (x.time && !validTime(x.time)) return res.status(400).json({ error: 'Час у форматі ГГ:ХХ' });
    s.meals[m] = { label: String(x.label || s.meals[m].label).slice(0, 30), time: x.time || s.meals[m].time, duration: Math.max(5, Math.min(180, +x.duration || s.meals[m].duration)) };
  }
  commit(); res.json({ settings: s });
});

// ---------- заявки гідів ----------
function guideFor(req, guideId) {
  if (req.user.role === 'guide') return req.user;
  if (['admin', 'head'].includes(req.user.role)) return db.users.find(u => u.id === guideId && u.role === 'guide');
  return null;
}
function canTouchRequest(user, r) {
  return ['admin', 'head'].includes(user.role) || (user.role === 'guide' && r.guideId === user.id);
}
app.post('/api/requests', auth, allow('guide', 'admin', 'head'), (req, res) => {
  const b = req.body || {};
  const g = guideFor(req, b.guideId);
  if (!g) return res.status(400).json({ error: 'Оберіть гіда/загін' });
  if (!MEALS.includes(b.meal)) return res.status(400).json({ error: 'Оберіть прийом їжі' });
  const count = Math.round(+b.count);
  if (!(count >= 1)) return res.status(400).json({ error: 'Вкажіть кількість дітей' });
  if (count > hallCapacity()) return res.status(400).json({ error: `У залі лише ${hallCapacity()} місць` });
  const now = nowParts();
  let date = validDate(b.date) ? b.date : now.date;
  const time = b.now || !b.time ? (b.now ? now.time : db.settings.meals[b.meal].time) : b.time;
  if (!validTime(time)) return res.status(400).json({ error: 'Час у форматі ГГ:ХХ' });
  // гід записує на час, який сьогодні вже минув (напр. увечері на сніданок) — це на завтра
  if (!validDate(b.date) && !b.now && toMin(time) + db.settings.meals[b.meal].duration <= now.min) {
    date = new Date(Date.parse(now.date + 'T12:00:00Z') + 864e5).toISOString().slice(0, 10);
  }
  const r = {
    id: uid(), date, meal: b.meal, time, count, diet: String(b.diet || '').slice(0, 200), adults: Math.max(0, Math.round(+b.adults || 0)),
    guideId: g.id, guideName: g.name, squad: g.squad, status: 'planned', tables: [], createdAt: Date.now(), createdBy: req.user.id,
  };
  const dup = db.requests.find(o => o.squad === r.squad && ACTIVE.includes(o.status) && o.date === date && o.meal === r.meal);
  if (dup) return res.status(400).json({ error: `Загін ${r.squad} вже записаний на «${db.settings.meals[r.meal].label}». Змініть існуючу заявку.` });
  allocate(r);
  db.requests.push(r); commit();
  res.json({ request: r });
});
app.put('/api/requests/:id', auth, (req, res) => {
  const r = db.requests.find(x => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: 'Не знайдено' });
  if (!canTouchRequest(req.user, r)) return res.status(403).json({ error: 'Немає прав' });
  if (!ACTIVE.includes(r.status)) return res.status(400).json({ error: 'Заявка вже закрита' });
  const b = req.body || {};
  if (b.count !== undefined) {
    const c = Math.round(+b.count);
    if (!(c >= 1) || c > hallCapacity()) return res.status(400).json({ error: 'Некоректна кількість' });
    r.count = c;
  }
  if (b.time !== undefined) { if (!validTime(b.time)) return res.status(400).json({ error: 'Час у форматі ГГ:ХХ' }); r.time = b.time; }
  if (b.diet !== undefined) r.diet = String(b.diet).slice(0, 200);
  if (b.adults !== undefined) r.adults = Math.max(0, Math.round(+b.adults || 0));
  allocate(r); processQueue(); commit();
  res.json({ request: r });
});
// дії: seated (прийшли), done (пішли), cancel
app.post('/api/requests/:id/status', auth, (req, res) => {
  const r = db.requests.find(x => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: 'Не знайдено' });
  const st = (req.body || {}).status;
  const staff = ['waiter', 'admin', 'head'].includes(req.user.role);
  if (!canTouchRequest(req.user, r) && !(staff && ['seated', 'done'].includes(st))) return res.status(403).json({ error: 'Немає прав' });
  if (st === 'seated') {
    if (r.status !== 'planned') return res.status(400).json({ error: 'Загін вже в залі або заявку закрито' });
    r.status = 'seated'; r.seatedAt = Date.now();
  } else if (st === 'done') { r.status = 'done'; r.doneAt = Date.now(); }
  else if (st === 'cancelled') { if (r.status !== 'planned') return res.status(400).json({ error: 'Скасувати можна лише до приходу' }); r.status = 'cancelled'; }
  else return res.status(400).json({ error: 'Невідомий статус' });
  if (st !== 'seated') {
    db.alerts.forEach(a => { if (a.requestId === r.id && !a.resolvedAt) a.resolvedAt = Date.now(); });
    processQueue();
  }
  commit(); res.json({ request: r });
});
// ручна пересадка (адмін/глава/офіціант)
app.post('/api/requests/:id/move', auth, allow('admin', 'head', 'waiter'), (req, res) => {
  const r = db.requests.find(x => x.id === req.params.id);
  if (!r || !ACTIVE.includes(r.status)) return res.status(404).json({ error: 'Активну заявку не знайдено' });
  const tables = parseZone((req.body || {}).tables);
  if (!tables.length) return res.status(400).json({ error: 'Вкажіть номери столів' });
  if (capacity(tables) < r.count) return res.status(400).json({ error: `За столами ${tables.join(', ')} лише ${capacity(tables)} місць, а дітей ${r.count}` });
  const busy = busyTables(r);
  const clash = tables.filter(t => busy.has(t));
  if (clash.length) return res.status(400).json({ error: `Столи ${clash.join(', ')} зайняті іншим загоном у цей час` });
  const old = r.tableState || {};
  r.tables = tables; r.need = tables.length; r.split = false; r.queued = false; r.manual = true;
  r.tableState = Object.fromEntries(tables.map(t => [t, old[t] || 'waiting']));
  r.portions = portions(r.count, tables);
  processQueue(); commit(); res.json({ request: r });
});
// офіціант: стіл накрито / потрібно ще
app.post('/api/requests/:id/table/:t', auth, allow('waiter', 'admin', 'head'), (req, res) => {
  const r = db.requests.find(x => x.id === req.params.id);
  const t = +req.params.t;
  if (!r || !r.tables.includes(t)) return res.status(404).json({ error: 'Стіл не належить цьому загону' });
  const st = (req.body || {}).state;
  if (!['waiting', 'served'].includes(st)) return res.status(400).json({ error: 'Невідомий стан' });
  r.tableState[t] = st;
  if (st === 'served') { r.servedBy = r.servedBy || {}; r.servedBy[t] = req.user.name; }
  commit(); res.json({ request: r });
});

// ---------- виклики офіціанта ----------
const ALERT_TYPES = { more: 'Добавка', bread: 'Хліб', water: 'Вода / чай', clean: 'Прибрати', other: 'Інше' };
app.post('/api/alerts', auth, allow('guide', 'admin', 'head'), (req, res) => {
  const b = req.body || {};
  const r = db.requests.find(x => x.id === b.requestId);
  if (!r || !canTouchRequest(req.user, r) || !ACTIVE.includes(r.status)) return res.status(400).json({ error: 'Немає активної заявки' });
  if (!ALERT_TYPES[b.type]) return res.status(400).json({ error: 'Невідомий тип' });
  const a = { id: uid(), date: r.date, requestId: r.id, squad: r.squad, guideName: r.guideName, tables: r.tables, type: b.type, label: ALERT_TYPES[b.type], text: String(b.text || '').slice(0, 120), createdAt: Date.now() };
  db.alerts.push(a); commit('alert'); res.json({ alert: a });
});
app.post('/api/alerts/:id/resolve', auth, allow('waiter', 'admin', 'head', 'cook', 'cook_assistant'), (req, res) => {
  const a = db.alerts.find(x => x.id === req.params.id);
  if (!a) return res.status(404).json({ error: 'Не знайдено' });
  a.resolvedAt = Date.now(); a.resolvedBy = req.user.name; commit(); res.json({ ok: true });
});

// ---------- кухня ----------
app.post('/api/kitchen', auth, allow('cook', 'cook_assistant', 'admin', 'head'), (req, res) => {
  const { meal, status } = req.body || {};
  if (!MEALS.includes(meal) || !['', 'cooking', 'ready'].includes(status)) return res.status(400).json({ error: 'Некоректні дані' });
  const date = nowParts().date;
  db.kitchen[date] = db.kitchen[date] || {};
  db.kitchen[date][meal] = { status, by: req.user.name, at: Date.now() };
  commit('kitchen'); res.json({ ok: true });
});

// ---------- звіт CSV ----------
app.get('/api/report.csv', auth, allow('admin', 'head', 'cook'), (req, res) => {
  const date = validDate(req.query.date) ? req.query.date : nowParts().date;
  const st = { planned: 'заплановано', seated: 'в залі', done: 'завершено', cancelled: 'скасовано' };
  const rows = [['Дата', 'Прийом їжі', 'Час', 'Загін', 'Гід', 'Дітей', 'Дорослих', 'Столи', 'Порції по столах', 'Статус', 'Харчування/алергії']];
  for (const r of db.requests.filter(x => x.date === date).sort((a, b) => MEALS.indexOf(a.meal) - MEALS.indexOf(b.meal) || toMin(a.time) - toMin(b.time))) {
    rows.push([r.date, db.settings.meals[r.meal].label, r.time, r.squad, r.guideName, r.count, r.adults || 0, r.tables.join(' '), (r.portions || []).join('+'), st[r.status] + (r.autoClosed ? ' (авто)' : ''), r.diet || '']);
  }
  const csv = '﻿' + rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(';')).join('\r\n');
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="report-${date}.csv"` });
  res.send(csv);
});

// ---------- автоматичне закриття ----------
function tick() {
  const now = nowParts();
  let changed = false;
  for (const r of db.requests) {
    if (!ACTIVE.includes(r.status)) continue;
    const ended = r.date < now.date || (r.date === now.date && now.min > toMin(r.time) + db.settings.meals[r.meal].duration + db.settings.autoCloseAfter);
    // загін, що сидить, закриваємо лише через годину після плану (раптом затримались)
    const seatedGrace = r.status === 'seated' && r.date === now.date && now.min <= toMin(r.time) + db.settings.meals[r.meal].duration + 60;
    if (ended && !seatedGrace) { r.status = 'done'; r.autoClosed = true; r.doneAt = Date.now(); changed = true; }
  }
  if (changed) {
    db.alerts.forEach(a => { const r = db.requests.find(x => x.id === a.requestId); if (!a.resolvedAt && (!r || !ACTIVE.includes(r.status))) a.resolvedAt = Date.now(); });
    processQueue();
  }
  // старі виклики й заявки старші за 60 днів прибираємо, щоб файл не ріс
  const cutoff = new Date(Date.now() - 60 * 864e5).toISOString().slice(0, 10);
  const before = db.requests.length + db.alerts.length;
  db.requests = db.requests.filter(r => r.date >= cutoff);
  db.alerts = db.alerts.filter(a => a.date >= cutoff);
  if (changed || before !== db.requests.length + db.alerts.length) commit();
}

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// Помилки не повинні «вішати» функцію
app.use((err, req, res, next) => { console.error(err); if (!res.headersSent) res.status(500).json({ error: 'Помилка сервера' }); });

// Локально: звичайний сервер. На Vercel: модуль експортує app, Vercel сам запускає його як функцію.
if (require.main === module) {
  loadDb().then(flushDb).then(() => {
    app.listen(PORT, () => console.log(`Їдальня табору працює: http://localhost:${PORT}  (дані: ${USE_REDIS ? 'Upstash Redis' : DB_FILE}, часовий пояс ${TZ})`));
    // підштовхує автозакриття заявок, навіть коли ніхто не заходить
    setInterval(() => fetch(`http://localhost:${PORT}/api/ping`).catch(() => {}), 30e3);
  }).catch(e => { console.error('Не вдалося запустити:', e); process.exit(1); });
}
module.exports = app;
