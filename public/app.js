/* Їдальня табору — клієнт (без фреймворків) */
'use strict';
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const toMin = t => { const [h, m] = String(t).split(':').map(Number); return h * 60 + m; };
const MEALS = ['breakfast', 'lunch', 'afternoon', 'dinner', 'snack'];
const ALERTS = { more: '🍲 Добавка', bread: '🍞 Хліб', water: '💧 Вода / чай', clean: '🧽 Прибрати', other: '✋ Інше' };
const STATUS = { planned: 'Заплановано', seated: 'У залі', done: 'Завершено', cancelled: 'Скасовано' };

const TABS = {
  admin: [['hall', 'Зал'], ['serve', 'Роздача'], ['requests', 'Заявки'], ['kitchen', 'Кухня'], ['alerts', 'Виклики'], ['users', 'Персонал'], ['settings', 'Налаштування'], ['report', 'Звіт']],
  head: [['hall', 'Зал'], ['serve', 'Роздача'], ['requests', 'Заявки'], ['kitchen', 'Кухня'], ['alerts', 'Виклики'], ['users', 'Персонал'], ['settings', 'Налаштування'], ['report', 'Звіт']],
  guide: [['guide', 'Мій загін'], ['hall', 'Зал']],
  waiter: [['hall', 'Зал'], ['serve', 'Роздача'], ['alerts', 'Виклики'], ['kitchen', 'Кухня']],
  cook: [['kitchen', 'Кухня'], ['serve', 'Роздача'], ['hall', 'Зал'], ['report', 'Звіт']],
  cook_assistant: [['kitchen', 'Кухня'], ['serve', 'Роздача'], ['hall', 'Зал']],
};

const S = { me: null, roles: {}, st: null, users: [], tab: null, date: null, live: false, onlyMine: false, guideForm: {}, lastAlertIds: null };

// ---------- утиліти ----------
async function api(path, opts = {}) {
  // зміни для іншого дня (адмін переглядає не сьогодні) — сервер має завантажити саме цей день
  if (opts.body || (opts.method && opts.method !== 'GET')) if (S.date && !path.includes('?')) path += `?date=${S.date}`;
  const res = await fetch(path, {
    method: opts.method || (opts.body ? 'POST' : 'GET'),
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  if (res.status === 401 && path !== '/api/login') { S.me = null; renderLogin(); throw new Error('Потрібно увійти'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Помилка сервера');
  return data;
}
let toastTimer;
function toast(msg, bad) {
  const t = $('#toast'); t.textContent = msg; t.className = 'toast' + (bad ? ' bad' : '');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), 2600);
}
async function act(fn, okMsg) {
  try { const r = await fn(); if (okMsg) toast(okMsg); await load(); return r; }
  catch (e) { toast(e.message, true); throw e; }
}
function openModal(html, onMount) {
  $('#modal-card').innerHTML = html; $('#modal').classList.remove('hidden');
  onMount && onMount($('#modal-card'));
}
function closeModal() { $('#modal').classList.add('hidden'); $('#modal-card').innerHTML = ''; }
$('#modal').addEventListener('click', e => { if (e.target.id === 'modal') closeModal(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

const mealLabel = m => S.st?.settings.meals[m]?.label || m;
const isToday = () => S.st && S.st.date === S.st.now.date;
const nowMin = () => toMin(S.st.now.time);
const active = r => r.status === 'planned' || r.status === 'seated';
function endOf(r) { return toMin(r.time) + S.st.settings.meals[r.meal].duration; }
function inMinutes(r) {
  const d = toMin(r.time) - nowMin();
  if (!isToday()) return r.time;
  if (d > 0) return d < 60 ? `через ${d} хв` : `о ${r.time}`;
  return d === 0 ? 'зараз' : `з ${r.time}`;
}
const fmtTime = ts => new Date(ts).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });

// ---------- звук для викликів ----------
let audioCtx;
function beep() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    [0, 0.18].forEach(d => {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.frequency.value = 880; o.connect(g); g.connect(audioCtx.destination);
      g.gain.setValueAtTime(0.0001, audioCtx.currentTime + d);
      g.gain.exponentialRampToValueAtTime(0.25, audioCtx.currentTime + d + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + d + 0.15);
      o.start(audioCtx.currentTime + d); o.stop(audioCtx.currentTime + d + 0.16);
    });
    navigator.vibrate && navigator.vibrate([120, 60, 120]);
  } catch { /* ignore */ }
}

// ---------- завантаження та живі оновлення ----------
async function load(soft) {
  const q = S.date ? `?date=${S.date}` : '';
  S.st = await api('/api/state' + q);
  if (['admin', 'head'].includes(S.me.role) && ['users'].includes(S.tab)) S.users = (await api('/api/users')).users;
  // нові виклики → звук для офіціантів і адмінів
  const ids = S.st.alerts.map(a => a.id);
  if (S.lastAlertIds && ['waiter', 'admin', 'head'].includes(S.me.role) && ids.some(id => !S.lastAlertIds.includes(id))) {
    beep(); toast('Новий виклик від загону!');
  }
  S.lastAlertIds = ids;
  soft ? softRender() : render();
}
let es, pollTimer;
// На Vercel постійного з'єднання немає: кожні 5 с питаємо крихітний номер версії і оновлюємось лише при змінах.
let lastVer = null, verTimer;
async function checkVersion() {
  if (document.hidden || !S.me) return;
  try {
    const { v } = await (await fetch('/api/version', { cache: 'no-store' })).json();
    S.live = true; paintLive();
    if (lastVer !== null && v !== lastVer) await load(true);
    lastVer = v;
  } catch { S.live = false; paintLive(); }
}
function connectLive() {
  clearInterval(verTimer); clearInterval(pollTimer);
  if (!S.liveMode) {
    if (es) es.close();
    verTimer = setInterval(checkVersion, 5000); checkVersion();
    pollTimer = setInterval(softRender, 20000); // оновити таймери «через N хв»
    return;
  }
  if (es) es.close();
  es = new EventSource('/api/events');
  const onEv = () => load(true).catch(() => {});
  ['update', 'alert', 'kitchen'].forEach(t => es.addEventListener(t, onEv));
  es.onopen = () => { S.live = true; paintLive(); };
  es.onerror = () => { S.live = false; paintLive(); };
  clearInterval(pollTimer);
  // запасний варіант: опитування кожні 20 с, якщо зв'язок «живих» оновлень обірвався
  pollTimer = setInterval(() => { if (!S.live) load(true).catch(() => {}); else softRender(); }, 20000);
}
function paintLive() { const d = $('#live'); if (d) { d.className = 'live' + (S.live ? '' : ' off'); d.title = S.live ? 'Оновлення в реальному часі' : 'Перепідключення…'; } }

// ---------- вхід ----------
function renderLogin() {
  if (es) es.close();
  $('#app').innerHTML = `
  <div class="login-wrap"><form class="login" id="login-form">
    <div class="plates"><span></span><span></span><span></span></div>
    <h1>Їдальня табору</h1>
    <div class="muted small">Увійдіть під акаунтом, який видав адміністратор або глава корпусу</div>
    <label>Логін</label><input name="login" autocomplete="username" required autofocus>
    <label>Пароль</label><input name="password" type="password" autocomplete="current-password" required>
    <div class="err" id="login-err"></div>
    <button class="btn block" style="margin-top:14px">Увійти</button>
  </form></div>`;
  $('#login-form').onsubmit = async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      const r = await api('/api/login', { body: { login: f.get('login'), password: f.get('password') } });
      await start(r.user);
    } catch (err) { $('#login-err').textContent = err.message; }
  };
}
async function start(user) {
  const me = await api('/api/me');
  S.me = me.user; S.roles = me.roles; S.liveMode = me.live !== false;
  S.tab = TABS[S.me.role][0][0];
  S.date = null;
  await load();
  connectLive();
  if (S.me.mustChange) changePassword(true);
}
function changePassword(forced) {
  openModal(`<h3>${forced ? 'Змініть стандартний пароль' : 'Зміна пароля'}</h3>
    <form id="pw"><label>Поточний пароль</label><input name="o" type="password" required>
    <label>Новий пароль</label><input name="n" type="password" minlength="4" required>
    <div class="btns"><button class="btn">Зберегти</button>${forced ? '' : '<button type="button" class="btn ghost" data-close>Скасувати</button>'}</div></form>`, m => {
    $('[data-close]', m)?.addEventListener('click', closeModal);
    $('#pw', m).onsubmit = async e => {
      e.preventDefault(); const f = new FormData(e.target);
      try { await api('/api/me/password', { body: { oldPassword: f.get('o'), newPassword: f.get('n') } }); S.me.mustChange = false; closeModal(); toast('Пароль змінено'); }
      catch (err) { toast(err.message, true); }
    };
  });
}

// ---------- каркас ----------
// Не перемальовуємо екран, поки людина друкує в полі — інакше «живе» оновлення зітре введене
function isTyping() {
  const ae = document.activeElement, v = $('#view');
  return ae && v && v.contains(ae) && ['INPUT', 'TEXTAREA', 'SELECT'].includes(ae.tagName) && !ae.dataset.keep;
}
document.addEventListener('focusout', () => setTimeout(() => { if (S.pending && !isTyping()) { S.pending = false; render(); } }, 150));
function softRender() { if (isTyping()) S.pending = true; else render(); }

function render() {
  if (!S.me || !S.st) return;
  const tabs = TABS[S.me.role];
  const alertsN = S.st.alerts.length;
  const roleLine = S.me.role === 'guide' ? `Загін ${esc(S.me.squad)}` : esc(S.roles[S.me.role]);
  const scrollY = window.scrollY;
  const focused = document.activeElement?.dataset?.keep;
  $('#app').innerHTML = `
  <header class="top">
    <div class="top-row">
      <div class="logo">${esc(S.st.settings.campName)}<small>Їдальня · ${esc(S.st.date)}${isToday() ? ' · ' + esc(S.st.now.time) : ''}</small></div>
      <div class="who"><b><span id="live" class="live"></span>${esc(S.me.name)}</b>${roleLine}</div>
      <button class="icon-btn" id="menu-btn" aria-label="Меню">⋯</button>
    </div>
    <nav class="tabs">${tabs.map(([k, l]) => `<button class="tab ${S.tab === k ? 'on' : ''}" data-tab="${k}">${l}${k === 'alerts' && alertsN ? `<span class="badge">${alertsN}</span>` : ''}</button>`).join('')}</nav>
  </header>
  <main id="view"></main>`;
  paintLive();
  $$('[data-tab]').forEach(b => b.onclick = async () => { S.tab = b.dataset.tab; if (S.tab === 'users') S.users = (await api('/api/users')).users; render(); window.scrollTo(0, 0); });
  $('#menu-btn').onclick = () => openModal(`<h3>${esc(S.me.name)}</h3><div class="muted small">${esc(S.roles[S.me.role])} · логін ${esc(S.me.login)}</div>
    <div class="btns"><button class="btn ghost block" id="m-pw">Змінити пароль</button><button class="btn danger block" id="m-out">Вийти</button></div>`, m => {
    $('#m-pw', m).onclick = () => changePassword(false);
    $('#m-out', m).onclick = async () => { await api('/api/logout', { method: 'POST' }); closeModal(); S.me = null; renderLogin(); };
  });
  const v = $('#view');
  ({ hall: viewHall, guide: viewGuide, kitchen: viewKitchen, alerts: viewAlerts, users: viewUsers, settings: viewSettings, report: viewReport, requests: viewRequests, serve: viewServe }[S.tab] || viewHall)(v);
  window.scrollTo(0, scrollY);
  if (focused) { const el = $(`[data-keep="${focused}"]`); el && el.focus(); }
}

// ---------- модель столів ----------
function tablesModel() {
  const st = S.st, map = {};
  for (const r of st.requests) {
    if (!active(r) || !r.tables.length) continue;
    r.tables.forEach((t, i) => (map[t] = map[t] || []).push({ r, i }));
  }
  const out = {};
  for (let t = 1; t <= st.settings.tables; t++) {
    let list = (map[t] || []).sort((a, b) => (b.r.status === 'seated') - (a.r.status === 'seated') || toMin(a.r.time) - toMin(b.r.time));
    if (isToday()) list = list.filter(x => x.r.status === 'seated' || endOf(x.r) > nowMin());
    const cur = list[0];
    let cls = 'free';
    if (cur) {
      const served = cur.r.tableState?.[t] === 'served';
      const soon = !isToday() ? false : toMin(cur.r.time) - nowMin() <= st.settings.remindBefore;
      cls = served ? 'served' : (cur.r.status === 'seated' || soon) ? 'need' : 'reserved';
    }
    out[t] = { t, cur, later: list.slice(1), cls };
  }
  return out;
}

// ---------- ЗАЛ ----------
function viewHall(v) {
  const st = S.st, model = tablesModel();
  const zone = S.me.role === 'waiter' ? (S.me.zone || []) : [];
  const myTables = new Set(S.me.role === 'guide' ? st.requests.filter(r => r.guideId === S.me.id && active(r)).flatMap(r => r.tables) : []);
  const vals = Object.values(model);
  const need = vals.filter(x => x.cls === 'need').length;
  const inHall = st.requests.filter(r => r.status === 'seated').reduce((s, r) => s + r.count, 0);
  const upcoming = st.requests.filter(r => r.status === 'planned' && (!isToday() || endOf(r) > nowMin())).reduce((s, r) => s + r.count, 0);
  const queued = st.requests.filter(r => active(r) && r.queued);
  const canStaff = ['waiter', 'admin', 'head'].includes(S.me.role);

  v.innerHTML = `
  ${dateBar()}
  ${st.alerts.length && canStaff ? `<div class="card alert-item" style="padding:10px 14px"><b>Виклики: ${st.alerts.length}</b> — ${st.alerts.slice(0, 3).map(a => `загін ${esc(a.squad)} (${esc(a.label)}, ст. ${a.tables.join(',')})`).join('; ')} <button class="btn sm warn" data-goto="alerts" style="margin-left:6px">Відкрити</button></div>` : ''}
  ${queued.length ? `<div class="card" style="border-color:#ecc8c5"><b style="color:var(--danger)">Черга — не вистачає вільних столів:</b> ${queued.map(r => `загін ${esc(r.squad)} (${r.count} дітей, ${esc(mealLabel(r.meal))} ${r.time})`).join('; ')}. Столи призначаться автоматично, щойно звільняться.</div>` : ''}
  <div class="hall-head">
    <div class="stats">
      <div class="stat ${need ? 'hot' : ''}"><b>${need}</b><span>столів накрити</span></div>
      <div class="stat"><b>${inHall}</b><span>дітей у залі</span></div>
      <div class="stat"><b>${upcoming}</b><span>ще прийде</span></div>
      <div class="stat"><b>${vals.filter(x => x.cls === 'free').length}/${st.settings.tables}</b><span>вільно</span></div>
    </div>
    ${zone.length ? `<label style="margin:0;display:flex;gap:8px;align-items:center;color:var(--ink)"><input type="checkbox" id="only-mine" style="width:20px;min-height:20px" ${S.onlyMine ? 'checked' : ''}> Лише мої столи (${zone.length})</label>` : ''}
  </div>
  ${hallGrid(vals, x => tableTile(x, { dim: (S.onlyMine && zone.length && !zone.includes(x.t)) || (myTables.size && !myTables.has(x.t)), hl: myTables.has(x.t) }))}
  <div class="legend">
    <span><i class="lg-chair on"></i>Стілець, куди ставити тарілку</span>
    <span><i class="lg-chair"></i>Вільне місце</span>
    <span><i style="background:var(--need);border:2px solid var(--need-line)"></i>Накрити зараз</span>
    <span><i style="background:var(--served)"></i>Накрито</span>
    <span><i style="background:var(--reserved)"></i>Заброньовано пізніше</span>
    <span><i style="background:var(--free)"></i>Вільний</span>
    <span>🧒 — загін уже в залі</span>
  </div>
  ${canStaff ? '' : '<p class="muted small">Натисніть на стіл, щоб побачити деталі.</p>'}`;
  bindDateBar(v);
  $('#only-mine', v)?.addEventListener('change', e => { S.onlyMine = e.target.checked; render(); });
  $$('[data-goto]', v).forEach(b => b.onclick = () => { S.tab = b.dataset.goto; render(); });
  $$('.tbl', v).forEach(el => el.onclick = () => tableModal(+el.dataset.t));
}
// ---------- стільці ----------
// Звичайний стіл: зверху 1-2-3, знизу 4-5-6. Великий стіл: ще 7-й стілець у торці (праворуч).
function parseNums(str) {
  const out = new Set();
  for (const part of String(str || '').split(/[,\s]+/).filter(Boolean)) {
    const m = part.match(/^(\d+)(?:-(\d+))?$/);
    if (m) for (let i = Math.min(+m[1], +(m[2] || m[1])); i <= Math.max(+m[1], +(m[2] || m[1])); i++) out.add(i);
  }
  return [...out];
}
function seatsOf(t) {
  const s = S.st.settings;
  return parseNums(s.bigTables).includes(t) ? (s.bigSeats || 7) : s.seats;
}
// Заповнюємо парами навпроти одне одного з лівого краю, торцевий стілець — останнім.
function seatOrder(total, side) {
  const top = Math.ceil(side / 2), bot = side - top, order = [];
  for (let k = 0; k < top; k++) { order.push(k); if (k < bot) order.push(top + k); }
  for (let k = side; k < total; k++) order.push(k);
  return order;
}
function tableParts(t, p, big) {
  const total = seatsOf(t), side = Math.min(total, S.st.settings.seats), top = Math.ceil(side / 2);
  const on = new Set(seatOrder(total, side).slice(0, p));
  const chair = idx => `<i class="${on.has(idx) ? 'on' : ''}">${big ? idx + 1 : ''}</i>`;
  const row = (from, to) => `<span class="chairs">${Array.from({ length: to - from }, (_, k) => chair(from + k)).join('')}</span>`;
  return {
    top: row(0, top), bot: row(top, side),
    ends: total > side ? `<span class="ends">${Array.from({ length: total - side }, (_, k) => chair(side + k)).join('')}</span>` : '',
    seatsOn: [...on].map(k => k + 1).sort((a, b) => a - b), total,
  };
}
function tableShape(t, p, inner, { big, cls = '', attrs = '' } = {}) {
  const parts = tableParts(t, p, big);
  return `<${big || cls.includes('mini') ? 'span' : 'button'} class="tbl ${cls} ${parts.ends ? 'has-end' : ''}" ${attrs}>
    ${parts.top}<span class="desk-row"><span class="desk">${inner}${parts.ends ? '' : '<span class="board"></span>'}</span>${parts.ends}</span>${parts.bot}
  </${big || cls.includes('mini') ? 'span' : 'button'}>`;
}
function hallGrid(vals, tileFn) {
  const pos = S.st.positions || vals.map((x, i) => ({ t: x.t, col: 0, row: i + 1 }));
  const nCols = Math.max(...pos.map(p => p.col)) + 1;
  const tpl = Array.from({ length: nCols }, () => 'minmax(0,1fr)').join(' var(--aisle) ');
  const maxRow = Math.max(...pos.map(p => p.row));
  const byT = Object.fromEntries(vals.map(x => [x.t, x]));
  const aisles = Array.from({ length: nCols - 1 }, (_, c) => `<div class="aisle" style="grid-column:${c * 2 + 2};grid-row:1 / ${maxRow + 1}"><span>прохід</span></div>`).join('');
  return `<div class="hall" style="grid-template-columns:${tpl};grid-template-rows:repeat(${maxRow},auto)">${aisles}
    ${pos.map(p => `<div class="slot" style="grid-column:${p.col * 2 + 1};grid-row:${p.row}">${tileFn(byT[p.t])}</div>`).join('')}</div>`;
}
function tableTile(x, { dim, hl }) {
  const cur = x.cur, r = cur?.r, p = cur ? (r.portions || [])[cur.i] || 0 : 0;
  let body;
  if (!cur) body = `<span class="num">${x.t}</span><span class="meta">${x.later.length ? `далі з-н ${esc(x.later[0].r.squad)} ${x.later[0].r.time}` : 'вільний'}${seatsOf(x.t) !== S.st.settings.seats ? ` · ${seatsOf(x.t)} місць` : ''}</span>`;
  else {
    const stateTxt = x.cls === 'served' ? 'накрито ✓' : x.cls === 'need' ? 'накрити!' : inMinutes(r);
    body = `<span class="num">${x.t}</span>
      <span class="info"><span class="sq">з-н ${esc(r.squad)}${r.status === 'seated' ? ' 🧒' : ''}${r.diet ? ' ⚠' : ''}</span>
      <span class="meta"><b>${p}</b> тар. · ${stateTxt}</span></span>`;
  }
  return tableShape(x.t, p, body, { cls: `${x.cls} ${dim ? 'mine-dim' : ''} ${hl ? 'hl' : ''}`, attrs: `data-t="${x.t}" aria-label="Стіл ${x.t}"` });
}
function bigTable(t, p) {
  const parts = tableParts(t, p, true);
  return `${tableShape(t, p, `<span class="num">${t}</span><span class="meta"><b>${p}</b> з ${parts.total} місць</span>`, { big: true, cls: `big ${p ? 'need' : 'free'}` })}
    <div class="muted small" style="margin-top:6px">Тарілки на стільці: <b>${parts.seatsOn.join(', ') || '—'}</b>${parts.total > S.st.settings.seats ? ` · стілець ${parts.total} — у торці стола` : ' · праворуч сервант'}</div>`;
}
function tableModal(t) {
  const x = tablesModel()[t];
  const role = S.me.role, staff = ['waiter', 'admin', 'head'].includes(role);
  if (!x.cur) {
    openModal(`<h3>Стіл №${t}</h3><p class="muted">Зараз вільний.</p>
      ${x.later.length ? '<h3>Наступні бронювання</h3>' + x.later.map(l => `<div class="item">Загін ${esc(l.r.squad)} · ${esc(mealLabel(l.r.meal))} ${l.r.time} · ${l.r.portions[l.i]} порц.</div>`).join('') : ''}
      <div class="btns"><button class="btn ghost" data-close>Закрити</button></div>`, m => $('[data-close]', m).onclick = closeModal);
    return;
  }
  const { r, i } = x.cur;
  const served = r.tableState?.[t] === 'served';
  openModal(`
    <h3>Стіл №${t} — загін ${esc(r.squad)}</h3>
    <div class="muted">${esc(r.guideName)} · ${esc(mealLabel(r.meal))} о ${r.time} · <span class="pill ${r.status}">${STATUS[r.status]}</span></div>
    <div style="margin:12px 0">${bigTable(t, r.portions[i])}</div>
    <div style="margin:0 0 12px;font-size:18px">На цей стіл: <b>${r.portions[i]} тарілок</b><br><span class="muted small">Усього загону: ${r.count} дітей${r.adults ? ` + ${r.adults} дорослих` : ''} на столах ${r.tables.map(n => `<span class="chip t">${n}</span>`).join('')}</span></div>
    ${r.diet ? `<div class="diet">⚠ ${esc(r.diet)}</div>` : ''}
    ${r.split ? '<p class="small" style="color:var(--need-ink)">Загін розсаджено на несусідні столи — не було вільного блоку поруч.</p>' : ''}
    ${staff ? `
      <div class="btns">
        ${served ? `<button class="btn ghost" data-st="waiting">Повернути в «накрити»</button>` : `<button class="btn green" data-st="served">✓ Стіл накрито</button>`}
        ${r.tables.length > 1 && !served ? `<button class="btn ghost" data-all>Накрито всі ${r.tables.length} столи загону</button>` : ''}
      </div>
      <div class="btns">
        ${r.status === 'planned' ? `<button class="btn ghost" data-status="seated">Загін прийшов</button>` : ''}
        <button class="btn ghost" data-status="done">Загін пішов — звільнити столи</button>
      </div>
      <label>Пересадити загін на столи (напр. 7,8 або 11-13)</label>
      <div class="row"><input id="mv" placeholder="${r.tables.join(',')}"><button class="btn ghost" id="mv-btn" style="flex:0 0 auto">Пересадити</button></div>` : ''}
    ${x.later.length ? '<h3 style="margin-top:14px">Далі за цим столом</h3>' + x.later.map(l => `<div class="small">Загін ${esc(l.r.squad)} · ${esc(mealLabel(l.r.meal))} ${l.r.time}</div>`).join('') : ''}
    <div class="btns"><button class="btn ghost" data-close>Закрити</button></div>`, m => {
    $('[data-close]', m).onclick = closeModal;
    $$('[data-st]', m).forEach(b => b.onclick = () => act(() => api(`/api/requests/${r.id}/table/${t}`, { body: { state: b.dataset.st } })).then(closeModal));
    $('[data-all]', m)?.addEventListener('click', () => act(() => Promise.all(r.tables.map(n => api(`/api/requests/${r.id}/table/${n}`, { body: { state: 'served' } }))), 'Усі столи загону накрито').then(closeModal));
    $$('[data-status]', m).forEach(b => b.onclick = () => act(() => api(`/api/requests/${r.id}/status`, { body: { status: b.dataset.status } })).then(closeModal));
    $('#mv-btn', m)?.addEventListener('click', () => act(() => api(`/api/requests/${r.id}/move`, { body: { tables: $('#mv', m).value } }), 'Пересаджено').then(closeModal));
  });
}
function dateBar() {
  if (!['admin', 'head', 'cook'].includes(S.me.role)) return '';
  return `<div class="row" style="margin-bottom:12px;max-width:420px"><div><label style="margin-top:0">День</label><input type="date" id="day" value="${S.st.date}"></div>
    ${isToday() ? '' : '<button class="btn ghost" id="today" style="flex:0 0 auto">Сьогодні</button>'}</div>`;
}
function bindDateBar(v) {
  $('#day', v)?.addEventListener('change', e => { S.date = e.target.value || null; load(); });
  $('#today', v)?.addEventListener('click', () => { S.date = null; load(); });
}

// ---------- ГІД ----------
function requestForm(guide, f) {
  const meals = S.st.settings.meals;
  const meal = f.meal || nextMeal();
  return `
  <label>Прийом їжі</label>
  <div class="seg" id="g-meal">${MEALS.map(m => `<button type="button" data-m="${m}" class="${m === meal ? 'on' : ''}">${esc(meals[m].label)}<br><span class="small" style="font-weight:500;opacity:.75">${meals[m].time}</span></button>`).join('')}</div>
  <label>Скільки дітей іде</label>
  <div class="stepper"><button type="button" data-d="-1">−</button><input id="g-count" data-keep="g-count" type="number" inputmode="numeric" min="1" value="${f.count ?? guide?.squadSize ?? ''}" placeholder="0"><button type="button" data-d="1">+</button></div>
  <div class="muted small" id="g-tables-hint"></div>
  <label>Коли</label>
  <div class="seg" id="g-when"><button type="button" data-w="now" class="${f.when === 'now' ? 'on' : ''}">Ідемо зараз</button><button type="button" data-w="time" class="${f.when !== 'now' ? 'on' : ''}">У визначений час</button></div>
  <input type="time" id="g-time" style="margin-top:8px" value="${f.time || meals[meal].time}" ${f.when === 'now' ? 'disabled' : ''}>
  <details style="margin-top:10px"><summary class="small" style="cursor:pointer;font-weight:600">Дорослі та харчові обмеження</summary>
    <label>Дорослих із загоном</label><input id="g-adults" type="number" min="0" value="${f.adults ?? 0}">
    <label>Дієта, алергії (для кухні)</label><input id="g-diet" value="${esc(f.diet || '')}" placeholder="напр. 2 без глютену, 1 без лактози">
  </details>`;
}
function nextMeal() {
  const meals = S.st.settings.meals, n = nowMin();
  return MEALS.find(m => toMin(meals[m].time) + meals[m].duration > n) || 'breakfast';
}
function bindRequestForm(root, f, guideSize) {
  const seats = S.st.settings.seats;
  const hint = () => { const c = +$('#g-count', root).value; $('#g-tables-hint', root).textContent = c > 0 ? `≈ ${Math.ceil(c / seats)} стол. по ${seats} місць` + (guideSize ? ` · у загоні ${guideSize}` : '') : ''; };
  $$('#g-meal button', root).forEach(b => b.onclick = () => {
    f.meal = b.dataset.m; $$('#g-meal button', root).forEach(x => x.classList.toggle('on', x === b));
    if (f.when !== 'now') { $('#g-time', root).value = S.st.settings.meals[f.meal].time; f.time = null; }
  });
  $$('.stepper button', root).forEach(b => b.onclick = () => { const i = $('#g-count', root); i.value = Math.max(1, (+i.value || 0) + +b.dataset.d); f.count = +i.value; hint(); });
  $('#g-count', root).oninput = e => { f.count = e.target.value; hint(); };
  $$('#g-when button', root).forEach(b => b.onclick = () => { f.when = b.dataset.w; $$('#g-when button', root).forEach(x => x.classList.toggle('on', x === b)); $('#g-time', root).disabled = f.when === 'now'; });
  $('#g-time', root).onchange = e => f.time = e.target.value;
  $('#g-adults', root).oninput = e => f.adults = e.target.value;
  $('#g-diet', root).oninput = e => f.diet = e.target.value;
  if (!f.meal) f.meal = nextMeal();
  hint();
}
function collectRequest(root, f) {
  return { meal: f.meal || nextMeal(), count: +$('#g-count', root).value, now: f.when === 'now', time: $('#g-time', root).value, adults: +$('#g-adults', root).value || 0, diet: $('#g-diet', root).value };
}
function viewGuide(v) {
  const mine = S.st.requests.filter(r => r.guideId === S.me.id).sort((a, b) => toMin(a.time) - toMin(b.time));
  const later = (S.st.upcoming || []).sort((a, b) => a.date.localeCompare(b.date) || toMin(a.time) - toMin(b.time));
  const f = S.guideForm;
  v.innerHTML = `<div class="grid2">
    <div>
      <div class="card"><h2>Загін ${esc(S.me.squad)} — записати на їжу</h2>
        ${requestForm(S.me, f)}
        <button class="btn block warn" id="g-send" style="margin-top:14px;font-size:17px">Записати загін</button>
      </div>
    </div>
    <div><h2>Сьогодні</h2><div class="list">${mine.length ? mine.map(guideCard).join('') : '<div class="empty card">Ще немає записів на сьогодні</div>'}</div>
      ${later.length ? `<h2 style="margin-top:18px">Наперед</h2><div class="list">${later.map(r => guideCard(r).replace('<b>', `<b>${r.date.slice(8)}.${r.date.slice(5, 7)} · `)).join('')}</div>` : ''}</div>
  </div>`;
  bindRequestForm(v, f, S.me.squadSize);
  $('#g-send', v).onclick = () => act(() => api('/api/requests', { body: collectRequest(v, f) })).then(r => {
    toast(r.request.date !== S.st.now.date ? `Записано на завтра (${r.request.date.slice(8)}.${r.request.date.slice(5, 7)}), столи призначено` : r.request.queued ? 'Записано, але вільних столів поки немає — загін у черзі' : `Записано! Столи: ${r.request.tables.join(', ')}`);
    S.guideForm = {}; render();
  }).catch(() => {});
  bindGuideCards(v);
}
function guideCard(r) {
  const on = active(r);
  return `<div class="item" data-r="${r.id}">
    <div class="item-top"><b>${esc(mealLabel(r.meal))} · ${r.time}</b><span class="pill ${r.queued ? 'queue' : r.status}">${r.queued ? 'Черга' : STATUS[r.status]}</span></div>
    <div style="margin:6px 0">${r.count} дітей${r.adults ? ` + ${r.adults} дор.` : ''} · ${r.tables.length ? 'столи ' + r.tables.map((t, i) => `<span class="chip t">${t}</span><span class="small muted">${r.portions[i]}п </span>`).join('') : '<span style="color:var(--danger)">чекає на вільні столи</span>'}</div>
    ${r.diet ? `<div class="diet">⚠ ${esc(r.diet)}</div>` : ''}
    ${on ? `
      <div class="row" style="margin-top:8px">
        <div class="stepper" style="flex:1 1 160px"><button type="button" data-cd="-1">−</button><input type="number" class="cnt" value="${r.count}" min="1"><button type="button" data-cd="1">+</button></div>
        <input type="time" class="tm" value="${r.time}" style="flex:0 1 120px" ${r.status === 'seated' ? 'disabled' : ''}>
        <button class="btn ghost sm" data-save style="flex:0 0 auto">Змінити</button>
      </div>
      <div class="btns">
        ${r.status === 'planned' ? `<button class="btn sm" data-s="seated">Ми в їдальні</button>` : ''}
        <button class="btn ghost sm" data-s="done">Ми пішли</button>
        ${r.status === 'planned' ? `<button class="btn danger sm" data-s="cancelled">Скасувати</button>` : ''}
      </div>
      ${r.tables.length ? `<div class="small muted" style="margin-top:10px">Покликати офіціанта:</div><div class="btns" style="margin-top:4px">${Object.entries(ALERTS).map(([k, l]) => `<button class="btn ghost sm" data-a="${k}">${l}</button>`).join('')}</div>` : ''}` : ''}
  </div>`;
}
function bindGuideCards(v) {
  $$('[data-r]', v).forEach(card => {
    const id = card.dataset.r;
    $$('[data-cd]', card).forEach(b => b.onclick = () => { const i = $('.cnt', card); i.value = Math.max(1, (+i.value || 0) + +b.dataset.cd); });
    $('[data-save]', card)?.addEventListener('click', () => act(() => api(`/api/requests/${id}`, { method: 'PUT', body: { count: +$('.cnt', card).value, time: $('.tm', card).value } }), 'Оновлено, столи перераховано'));
    $$('[data-s]', card).forEach(b => b.onclick = () => {
      if (b.dataset.s === 'cancelled' && !confirm('Скасувати запис?')) return;
      act(() => api(`/api/requests/${id}/status`, { body: { status: b.dataset.s } }), b.dataset.s === 'done' ? 'Столи звільнено' : 'Готово');
    });
    $$('[data-a]', card).forEach(b => b.onclick = () => {
      const text = b.dataset.a === 'other' ? prompt('Що потрібно?') : '';
      if (text === null) return;
      act(() => api('/api/alerts', { body: { requestId: id, type: b.dataset.a, text } }), 'Офіціанта покликано');
    });
  });
}

// ---------- ЗАЯВКИ (адмін/глава) ----------
function viewRequests(v) {
  const reqs = S.st.requests.slice().sort((a, b) => MEALS.indexOf(a.meal) - MEALS.indexOf(b.meal) || toMin(a.time) - toMin(b.time));
  const f = S.guideForm;
  v.innerHTML = `${dateBar()}<div class="grid2">
    <div class="card"><h2>Заявки на ${esc(S.st.date)}</h2>
      ${reqs.length ? `<div class="table-wrap"><table class="data"><tr><th>Їжа</th><th>Час</th><th>Загін</th><th>Дітей</th><th>Столи</th><th>Статус</th><th></th></tr>
      ${reqs.map(r => `<tr><td>${esc(mealLabel(r.meal))}</td><td>${r.time}</td><td><b>${esc(r.squad)}</b><div class="small muted">${esc(r.guideName)}</div></td><td>${r.count}${r.adults ? '+' + r.adults : ''}${r.diet ? ' <span title="' + esc(r.diet) + '">⚠</span>' : ''}</td>
        <td>${r.tables.map(t => `<span class="chip t">${t}</span>`).join('') || '<span class="pill queue">черга</span>'}</td><td><span class="pill ${r.status}">${STATUS[r.status]}${r.autoClosed ? ' (авто)' : ''}</span></td>
        <td>${active(r) ? `<button class="btn ghost sm" data-edit="${r.id}">Змінити</button>` : ''}</td></tr>`).join('')}</table></div>` : '<div class="empty">Заявок немає</div>'}
    </div>
    <div class="card"><h2>Записати загін за гіда</h2>
      <label>Гід / загін</label><select id="g-guide"><option value="">— оберіть —</option>${S.st.guides.map(g => `<option value="${g.id}" ${f.guideId === g.id ? 'selected' : ''}>Загін ${esc(g.squad)} — ${esc(g.name)}</option>`).join('')}</select>
      ${requestForm(S.st.guides.find(g => g.id === f.guideId), f)}
      <button class="btn block warn" id="g-send" style="margin-top:14px">Записати</button>
    </div></div>`;
  bindDateBar(v);
  $('#g-guide', v).onchange = e => { f.guideId = e.target.value; f.count = S.st.guides.find(g => g.id === f.guideId)?.squadSize ?? f.count; render(); };
  bindRequestForm(v, f);
  $('#g-send', v).onclick = () => act(() => api('/api/requests', { body: { ...collectRequest(v, f), guideId: f.guideId, date: S.st.date } }), 'Записано').then(() => { S.guideForm = {}; render(); }).catch(() => {});
  $$('[data-edit]', v).forEach(b => b.onclick = () => {
    const r = S.st.requests.find(x => x.id === b.dataset.edit);
    openModal(`<h3>Загін ${esc(r.squad)} · ${esc(mealLabel(r.meal))}</h3>${guideCard(r)}
      <div class="btns"><button class="btn ghost" data-close>Закрити</button></div>`, m => {
      bindGuideCards(m);
      $$('button', m).forEach(x => x.addEventListener('click', () => { if (!x.dataset.cd) setTimeout(closeModal, 50); }));
    });
  });
}

// ---------- КУХНЯ ----------
function viewKitchen(v) {
  const st = S.st, meals = st.settings.meals, n = nowMin();
  const canSet = ['cook', 'cook_assistant', 'admin', 'head'].includes(S.me.role) && isToday();
  const totalDay = st.requests.filter(r => r.status !== 'cancelled').reduce((s, r) => s + r.count + (r.adults || 0), 0);
  const cards = MEALS.map(m => {
    const rs = st.requests.filter(r => r.meal === m && r.status !== 'cancelled');
    const kids = rs.reduce((s, r) => s + r.count, 0), adults = rs.reduce((s, r) => s + (r.adults || 0), 0);
    const left = rs.filter(r => r.status === 'planned').reduce((s, r) => s + r.count + (r.adults || 0), 0);
    const slots = {};
    rs.forEach(r => { (slots[r.time] = slots[r.time] || { n: 0, sq: [] }); slots[r.time].n += r.count + (r.adults || 0); slots[r.time].sq.push(r.squad); });
    const k = st.kitchen[m] || {};
    const isNow = isToday() && n >= toMin(meals[m].time) - 60 && n <= toMin(meals[m].time) + meals[m].duration + 30;
    return `<div class="card meal-card ${isNow ? 'now' : ''}">
      <div class="item-top"><h3>${esc(meals[m].label)} <span class="muted small">${meals[m].time}</span></h3>
        <span class="kstatus ${k.status || ''}">${k.status === 'ready' ? '● Готово до видачі' : k.status === 'cooking' ? '● Готується' : ''}</span></div>
      <div class="big">${kids + adults}</div><div class="muted small">порцій: ${kids} дітей${adults ? ` + ${adults} дорослих` : ''} · загонів: ${rs.length}${left ? ` · ще не прийшли: ${left}` : ''}</div>
      ${Object.keys(slots).length ? `<div class="slots">${Object.entries(slots).sort((a, b) => toMin(a[0]) - toMin(b[0])).map(([t, s]) => `<div class="slot"><span><b>${t}</b> · з-ни ${s.sq.map(esc).join(', ')}</span><b>${s.n}</b></div>`).join('')}</div>` : '<div class="muted small" style="margin-top:8px">Заявок ще немає</div>'}
      ${rs.filter(r => r.diet).map(r => `<div class="diet">⚠ Загін ${esc(r.squad)}: ${esc(r.diet)}</div>`).join('')}
      ${canSet ? `<div class="btns"><button class="btn sm ${k.status === 'cooking' ? '' : 'ghost'}" data-k="${m}" data-v="cooking">Готується</button><button class="btn sm ${k.status === 'ready' ? 'green' : 'ghost'}" data-k="${m}" data-v="ready">Готово</button>${k.status ? `<button class="btn sm ghost" data-k="${m}" data-v="">Скинути</button>` : ''}</div>` : ''}
    </div>`;
  }).join('');
  v.innerHTML = `${dateBar()}<div class="hall-head"><h2 style="margin:0">Кухня — ${esc(st.date)}</h2><div class="stat"><b>${totalDay}</b><span>порцій за день</span></div></div><div class="grid3">${cards}</div>`;
  bindDateBar(v);
  $$('[data-k]', v).forEach(b => b.onclick = () => act(() => api('/api/kitchen', { body: { meal: b.dataset.k, status: b.dataset.v } })));
}

// ---------- РОЗДАЧА: готовий список «який стіл — скільки тарілок» ----------
function viewServe(v) {
  const st = S.st;
  const staff = ['waiter', 'admin', 'head'].includes(S.me.role);
  const pos = st.positions || [];
  const colName = c => (pos.length && Math.max(...pos.map(p => p.col)) === 1) ? (c === 0 ? 'Ліва колонка' : 'Права колонка') : `Колонка ${c + 1}`;
  const rs = st.requests.filter(r => active(r) && r.tables.length && (!isToday() || r.status === 'seated' || endOf(r) > nowMin()));
  const groups = {};
  rs.forEach(r => { const k = `${String(toMin(r.time)).padStart(4, '0')}|${r.meal}|${r.time}`; (groups[k] = groups[k] || []).push(r); });
  const keys = Object.keys(groups).sort();
  v.innerHTML = `${dateBar()}<h2>Роздача — що й куди ставити</h2>
    <p class="muted small" style="margin-top:-6px">Система вже розбила дітей по столах і стільцях. Кольорові стільці — сюди тарілка.</p>
    ${keys.length ? keys.map(k => {
      const [, meal, time] = k.split('|'), list = groups[k];
      const rows = list.flatMap(r => r.tables.map((t, i) => ({ t, p: r.portions[i], r }))).sort((a, b) => a.t - b.t);
      const plates = rows.reduce((s, x) => s + x.p, 0), adults = list.reduce((s, r) => s + (r.adults || 0), 0);
      const done = rows.filter(x => x.r.tableState?.[x.t] === 'served').length;
      const cols = {}; rows.forEach(x => { const c = pos[x.t - 1]?.col ?? 0; cols[c] = (cols[c] || 0) + x.p; });
      const soon = isToday() ? toMin(time) - nowMin() : 999;
      return `<div class="serve-group card">
        <div class="serve-head"><h3 style="margin:0">${esc(mealLabel(meal))} · ${time} <span class="muted small">${isToday() ? (soon > 0 ? `через ${soon} хв` : 'зараз') : ''}</span></h3>
          <span><b style="font-size:20px">${plates}</b> тарілок${adults ? ` + ${adults} дорослим` : ''} · ${rows.length} стол. · накрито ${done}/${rows.length}</span></div>
        <div class="colsum" style="margin-bottom:10px">${Object.entries(cols).map(([c, n]) => `<span class="chip">${colName(+c)}: ${n} тар.</span>`).join('')}</div>
        ${rows.map(x => {
          const served = x.r.tableState?.[x.t] === 'served';
          return `<div class="serve-row ${served ? 'done' : ''}">
            <div class="tn">${x.t}</div>
            <div style="min-width:0"><div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap"><span class="pl">${x.p} 🍽</span>
              ${tableShape(x.t, x.p, '', { cls: `${served ? 'served' : 'need'} mini` })}</div>
              <div class="small muted">Загін ${esc(x.r.squad)} · ${esc(x.r.guideName)}</div>${x.r.diet ? `<div class="diet" style="margin-top:4px">⚠ ${esc(x.r.diet)}</div>` : ''}</div>
            ${staff ? `<button class="btn sm ${served ? 'ghost' : 'green'}" data-sv="${x.r.id}|${x.t}|${served ? 'waiting' : 'served'}">${served ? '↺' : '✓ Накрито'}</button>` : ''}
          </div>`;
        }).join('')}
        ${staff && done < rows.length ? `<button class="btn ghost block" data-svall="${k}">Позначити всі ${rows.length} столи накритими</button>` : ''}
      </div>`;
    }).join('') : '<div class="empty card">Зараз нічого накривати не треба</div>'}`;
  bindDateBar(v);
  $$('[data-sv]', v).forEach(b => b.onclick = () => { const [id, t, state] = b.dataset.sv.split('|'); act(() => api(`/api/requests/${id}/table/${t}`, { body: { state } })); });
  $$('[data-svall]', v).forEach(b => b.onclick = () => {
    const list = groups[b.dataset.svall];
    act(() => Promise.all(list.flatMap(r => r.tables.filter(t => r.tableState?.[t] !== 'served').map(t => api(`/api/requests/${r.id}/table/${t}`, { body: { state: 'served' } })))), 'Усе накрито');
  });
}

// ---------- ВИКЛИКИ ----------
function viewAlerts(v) {
  const al = S.st.alerts.slice().sort((a, b) => a.createdAt - b.createdAt);
  v.innerHTML = `<h2>Виклики від гідів</h2><div class="list">${al.length ? al.map(a => `
    <div class="item alert-item"><div class="item-top"><b>${esc(a.label)} — загін ${esc(a.squad)}</b><span class="when">${fmtTime(a.createdAt)} · ${Math.max(0, Math.round((Date.now() - a.createdAt) / 60000))} хв тому</span></div>
    <div>Столи: ${a.tables.map(t => `<span class="chip t">${t}</span>`).join('')} · ${esc(a.guideName)}</div>
    ${a.text ? `<div class="diet">${esc(a.text)}</div>` : ''}
    <div class="btns"><button class="btn green sm" data-res="${a.id}">Виконано</button></div></div>`).join('') : '<div class="empty card">Немає активних викликів 👍</div>'}</div>`;
  $$('[data-res]', v).forEach(b => b.onclick = () => act(() => api(`/api/alerts/${b.dataset.res}/resolve`, { method: 'POST' }), 'Позначено виконаним'));
}

// ---------- ПЕРСОНАЛ ----------
function allowedRoles() {
  return S.me.role === 'admin' ? Object.keys(S.roles) : ['guide', 'waiter', 'cook', 'cook_assistant'];
}
function userFields(u = {}, role) {
  role = role || u.role || 'guide';
  return `
  <label>Роль</label><select name="role" id="u-role">${allowedRoles().map(r => `<option value="${r}" ${r === role ? 'selected' : ''}>${esc(S.roles[r])}</option>`).join('')}</select>
  <label>Ім’я</label><input name="name" value="${esc(u.name || '')}" required>
  <div id="u-guide" class="${role === 'guide' ? '' : 'hidden'}"><div class="row">
    <div><label>Номер загону</label><input name="squad" value="${esc(u.squad || '')}" placeholder="напр. 5"></div>
    <div><label>Дітей у загоні</label><input name="squadSize" type="number" min="1" value="${u.squadSize || ''}" placeholder="напр. 18"></div></div></div>
  <div id="u-waiter" class="${role === 'waiter' ? '' : 'hidden'}"><label>Зона офіціанта (столи)</label><input name="zone" value="${(u.zone || []).join(',')}" placeholder="напр. 1-10"></div>`;
}
function bindUserRole(root) {
  $('#u-role', root).onchange = e => { $('#u-guide', root).classList.toggle('hidden', e.target.value !== 'guide'); $('#u-waiter', root).classList.toggle('hidden', e.target.value !== 'waiter'); };
}
function pwCell(u) {
  if (u.password === undefined) return '';
  if (u.password === null) return '<span class="small muted" title="Акаунт створено до появи цієї функції — задайте пароль ще раз через «Змінити»">пароль невідомий</span>';
  const shown = S.showPw && S.showPw[u.id];
  return `<span class="pw"><code>${shown ? esc(u.password) : '••••••'}</code>
    <button class="btn ghost sm" data-pw="${u.id}" title="${shown ? 'Сховати' : 'Показати'}">${shown ? '🙈' : '👁'}</button>
    <button class="btn ghost sm" data-copy="${u.id}" title="Скопіювати логін і пароль">⧉</button></span>`;
}
function viewUsers(v) {
  const groups = Object.keys(S.roles).map(r => [r, S.users.filter(u => u.role === r)]).filter(([, l]) => l.length);
  const canEdit = u => S.me.role === 'admin' || allowedRoles().includes(u.role);
  v.innerHTML = `<div class="grid2">
    <div>${groups.map(([r, list]) => `<div class="card"><h3>${esc(S.roles[r])} <span class="muted small">(${list.length})</span></h3>
      <div class="table-wrap"><table class="data">${list.sort((a, b) => String(a.squad || a.name).localeCompare(String(b.squad || b.name), 'uk', { numeric: true })).map(u => `<tr>
        <td><b>${esc(u.name)}</b><div class="small muted">логін: ${esc(u.login)}</div></td>
        <td>${u.role === 'guide' ? `Загін <b>${esc(u.squad)}</b>${u.squadSize ? ` · ${u.squadSize} дітей` : ''}` : u.role === 'waiter' ? (u.zone.length ? `Столи ${u.zone.join(',')}` : '<span class="muted">усі столи</span>') : ''}</td>
        <td>${pwCell(u)}</td>
        <td style="text-align:right">${canEdit(u) && u.id !== S.me.id ? `<button class="btn ghost sm" data-ed="${u.id}">Змінити</button>` : ''}</td></tr>`).join('')}</table></div></div>`).join('')}</div>
    <div class="card"><h2>Новий акаунт</h2><form id="u-new">${userFields()}
      <div class="row"><div><label>Логін</label><input name="login" required placeholder="напр. gid5"></div><div><label>Пароль</label><input name="password" required minlength="4"></div></div>
      <button class="btn block" style="margin-top:14px">Створити акаунт</button></form>
      <p class="muted small">Передайте логін і пароль співробітнику — він увійде з телефона за адресою цього сайту.</p></div>
  </div>`;
  bindUserRole(v);
  $$('[data-pw]', v).forEach(b => b.onclick = () => { S.showPw = S.showPw || {}; S.showPw[b.dataset.pw] = !S.showPw[b.dataset.pw]; render(); });
  $$('[data-copy]', v).forEach(b => b.onclick = async () => {
    const u = S.users.find(x => x.id === b.dataset.copy);
    const text = `Сайт: ${location.origin}\nЛогін: ${u.login}\nПароль: ${u.password}`;
    try { await navigator.clipboard.writeText(text); toast('Логін і пароль скопійовано'); } catch { prompt('Скопіюйте:', text); }
  });
  $('#u-new', v).onsubmit = e => {
    e.preventDefault(); const body = Object.fromEntries(new FormData(e.target));
    act(() => api('/api/users', { body }), `Акаунт «${body.login}» створено`).then(async () => { S.users = (await api('/api/users')).users; render(); }).catch(() => {});
  };
  $$('[data-ed]', v).forEach(b => b.onclick = () => {
    const u = S.users.find(x => x.id === b.dataset.ed);
    openModal(`<h3>${esc(u.name)}</h3><div class="muted small">логін: ${esc(u.login)}${u.password ? ` · поточний пароль: <code>${esc(u.password)}</code>` : ''}</div><form id="u-ed">${userFields(u)}
      <label>Новий пароль (залиште порожнім, щоб не змінювати)</label><input name="password" minlength="4">
      <div class="btns"><button class="btn">Зберегти</button><button type="button" class="btn ghost" data-close>Скасувати</button><button type="button" class="btn danger" id="u-del">Видалити</button></div></form>`, m => {
      bindUserRole(m);
      $('[data-close]', m).onclick = closeModal;
      $('#u-ed', m).onsubmit = e => {
        e.preventDefault(); const body = Object.fromEntries(new FormData(e.target)); if (!body.password) delete body.password;
        act(() => api(`/api/users/${u.id}`, { method: 'PUT', body }), 'Збережено').then(async () => { closeModal(); S.users = (await api('/api/users')).users; render(); }).catch(() => {});
      };
      $('#u-del', m).onclick = () => { if (confirm(`Видалити акаунт ${u.name}?`)) act(() => api(`/api/users/${u.id}`, { method: 'DELETE' }), 'Видалено').then(async () => { closeModal(); S.users = (await api('/api/users')).users; render(); }); };
    });
  });
}

// ---------- НАЛАШТУВАННЯ ----------
function viewSettings(v) {
  const s = S.st.settings;
  v.innerHTML = `<form id="set" class="grid2">
    <div class="card"><h2>Розклад їжі</h2>
      <div class="table-wrap"><table class="data"><tr><th>Назва</th><th>Час</th><th>Триває, хв</th></tr>
      ${MEALS.map(m => `<tr><td><input name="${m}.label" value="${esc(s.meals[m].label)}"></td><td><input type="time" name="${m}.time" value="${s.meals[m].time}"></td><td><input type="number" min="5" max="180" name="${m}.duration" value="${s.meals[m].duration}"></td></tr>`).join('')}</table></div>
      <p class="muted small">Тривалість визначає, на скільки столи зайняті загоном. Якщо два загони йдуть в один час — вони отримають різні столи; якщо в різний — столи можуть повторюватись.</p>
    </div>
    <div class="card"><h2>Зал</h2>
      <label>Назва табору</label><input name="campName" value="${esc(s.campName)}">
      <label>Схема залу — колонки столів (ряди зверху вниз; пропуск = прохід)</label>
      ${[0, 1, 2].map(c => `<input name="layout${c}" value="${esc((s.layout || [])[c] || '')}" placeholder="${c === 0 ? 'напр. 1-6,8-13' : c === 1 ? 'напр. 1-13' : 'третя колонка (не обов’язково)'}" style="margin-bottom:6px">`).join('')}
      <div class="muted small">Зараз столів: ${s.tables}. Нумерація йде по колонках зверху вниз.</div>
      <div class="row"><div><label>Місць за звичайним столом</label><input type="number" name="seats" value="${s.seats}" min="1"></div>
        <div><label>Місць за великим столом</label><input type="number" name="bigSeats" value="${s.bigSeats || 7}" min="1"></div></div>
      <label>Великі столи (номери, напр. 1,5,13,20,25)</label><input name="bigTables" value="${esc(s.bigTables || '')}" placeholder="столи, де 7 стільців">
      <div class="row"><div><label>Нагадувати накрити за, хв</label><input type="number" name="remindBefore" value="${s.remindBefore}" min="0"></div><div><label>Автозакриття після кінця, хв</label><input type="number" name="autoCloseAfter" value="${s.autoCloseAfter}" min="0"></div></div>
      <button class="btn block" style="margin-top:14px">Зберегти налаштування</button>
    </div></form>`;
  $('#set', v).onsubmit = e => {
    e.preventDefault(); const f = Object.fromEntries(new FormData(e.target));
    const body = { campName: f.campName, layout: [f.layout0, f.layout1, f.layout2].filter(x => x && x.trim()), seats: f.seats, bigSeats: f.bigSeats, bigTables: f.bigTables, remindBefore: f.remindBefore, autoCloseAfter: f.autoCloseAfter, meals: {} };
    MEALS.forEach(m => body.meals[m] = { label: f[m + '.label'], time: f[m + '.time'], duration: f[m + '.duration'] });
    act(() => api('/api/settings', { method: 'PUT', body }), 'Збережено');
  };
}

// ---------- ЗВІТ ----------
function viewReport(v) {
  const st = S.st, rs = st.requests.filter(r => r.status !== 'cancelled');
  const sumBy = m => rs.filter(r => r.meal === m).reduce((s, r) => s + r.count + (r.adults || 0), 0);
  const squads = [...new Set(rs.map(r => r.squad))].sort((a, b) => String(a).localeCompare(String(b), 'uk', { numeric: true }));
  v.innerHTML = `${dateBar()}<div class="card"><div class="item-top"><h2>Звіт за ${esc(st.date)}</h2><a class="btn ghost sm" href="/api/report.csv?date=${st.date}">Завантажити CSV (Excel)</a></div>
    <div class="table-wrap"><table class="data"><tr><th>Загін</th>${MEALS.map(m => `<th>${esc(mealLabel(m))}</th>`).join('')}</tr>
    ${squads.map(sq => `<tr><td><b>${esc(sq)}</b></td>${MEALS.map(m => { const r = rs.find(x => x.squad === sq && x.meal === m); return `<td>${r ? r.count + (r.adults ? '+' + r.adults : '') : '—'}</td>`; }).join('')}</tr>`).join('')}
    <tr><td><b>Разом</b></td>${MEALS.map(m => `<td><b>${sumBy(m)}</b></td>`).join('')}</tr></table></div>
    ${squads.length ? '' : '<div class="empty">Даних немає</div>'}</div>`;
  bindDateBar(v);
}

// ---------- старт ----------
api('/api/me').then(r => start(r.user)).catch(() => renderLogin());
// повернулись у вкладку / розблокували телефон — одразу підтягнути свіжі дані
document.addEventListener('visibilitychange', () => { if (!document.hidden && S.me) load(true).catch(() => {}); });
