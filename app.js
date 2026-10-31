'use strict';

/* =========================================================================
   Budget Tracker — runs entirely in the browser. Data is kept in
   localStorage on this device; use Settings → Export to back it up.
   ========================================================================= */

const STORAGE_KEY = 'budget-tracker:v1';
const COLORS = ['#4f6bed', '#1f9d6b', '#e09b1a', '#d9434a', '#8e4ec6', '#1597b8', '#d63f86', '#7c8a3a', '#d9730d', '#6b7280'];
const EXPENSE_CATEGORIES = ['Housing', 'Groceries', 'Transport', 'Utilities', 'Dining out', 'Health', 'Entertainment', 'Shopping', 'Education', 'Other'];
const INCOME_CATEGORIES = ['Salary', 'Freelance', 'Other income'];
const FREQUENCIES = { weekly: 'Weekly', biweekly: 'Every 2 weeks', monthly: 'Monthly', yearly: 'Yearly' };
const CURRENCIES = ['USD', 'EUR', 'GBP', 'PKR', 'INR', 'AED', 'SAR', 'CAD', 'AUD', 'JPY', 'CNY', 'TRY', 'BDT', 'NGN'];
const VIEWS = ['dashboard', 'transactions', 'budgets', 'scheduled', 'forecast', 'goals', 'settings'];
const MONTH_VIEWS = ['dashboard', 'transactions', 'budgets'];

/* ---------- Small helpers ---------- */

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const pad = n => String(n).padStart(2, '0');
const toDateStr = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayStr = () => toDateStr(new Date());
const monthKey = s => s.slice(0, 7);
const sum = (arr, f = x => x) => arr.reduce((a, x) => a + f(x), 0);
const byDateDesc = (a, b) => b.date.localeCompare(a.date) || (b.created || 0) - (a.created || 0);

function parseDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function addDays(s, n) {
  const d = parseDate(s);
  d.setDate(d.getDate() + n);
  return toDateStr(d);
}

function shiftMonth(key, delta) {
  const [y, m] = key.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

function monthName(key, short = false) {
  if (startDay() > 1) {
    const start = parseDate(periodStart(key));
    if (short) return start.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    const end = parseDate(periodEnd(key));
    const sameYear = start.getFullYear() === end.getFullYear();
    return `${start.toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) })} – ${end.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`;
  }
  const [y, m] = key.split('-').map(Number);
  const opts = short ? { month: 'short' } : { month: 'long', year: 'numeric' };
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, opts);
}

function fmtDate(s) {
  const d = parseDate(s);
  const opts = { month: 'short', day: 'numeric' };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString(undefined, opts);
}

function daysInMonth(y, m0) {
  return new Date(y, m0 + 1, 0).getDate();
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function money(n) {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: state.settings.currency }).format(n);
  } catch {
    return (Math.round(n * 100) / 100).toFixed(2);
  }
}

/* ---------- State & storage ---------- */

function defaultState() {
  const cat = (name, kind, i) => ({ id: uid(), name, kind, color: COLORS[i % COLORS.length], budget: 0 });
  return {
    version: 1,
    settings: { currency: 'AED', plannedIncome: 0, openingBalance: 0 },
    categories: [
      ...EXPENSE_CATEGORIES.map((n, i) => cat(n, 'expense', i)),
      ...INCOME_CATEGORIES.map((n, i) => cat(n, 'income', i + 1)),
    ],
    transactions: [],
    recurring: [],
    goals: [],
    merchantRules: {},
  };
}

function normalize(obj) {
  const base = defaultState();
  if (!obj || typeof obj !== 'object' || !Array.isArray(obj.categories) || !Array.isArray(obj.transactions)) {
    throw new Error('This file does not look like a Budget Tracker backup.');
  }
  return {
    version: 1,
    settings: { ...base.settings, ...(obj.settings || {}) },
    categories: obj.categories,
    transactions: obj.transactions.map(t => ({ ...t, amount: Number(t.amount) || 0 })),
    recurring: Array.isArray(obj.recurring) ? obj.recurring : [],
    goals: Array.isArray(obj.goals) ? obj.goals : [],
    merchantRules: obj.merchantRules && typeof obj.merchantRules === 'object' ? obj.merchantRules : {},
  };
}

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return normalize(JSON.parse(raw));
  } catch (err) {
    console.warn('Could not load saved data', err);
  }
  return defaultState();
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (err) {
    toast('Could not save — your browser is blocking storage.');
  }
}

let state = load();
const ui = {
  view: 'dashboard',
  month: '',
  search: '',
  filterType: '',
  filterCat: '',
  forecast: 'period',
};

ui.month = periodKeyFor(todayStr());

const catById = id => state.categories.find(c => c.id === id) || { id: '', name: 'Uncategorized', color: '#9ca3af', kind: 'expense' };
const categoriesOf = kind => state.categories.filter(c => c.kind === kind);

/* ---------- Scheduled (recurring) transactions ---------- */

function nextOccurrence(dateStr, freq, anchorDay) {
  if (freq === 'weekly') return addDays(dateStr, 7);
  if (freq === 'biweekly') return addDays(dateStr, 14);
  const d = parseDate(dateStr);
  const first = new Date(d.getFullYear() + (freq === 'yearly' ? 1 : 0), d.getMonth() + (freq === 'monthly' ? 1 : 0), 1);
  const day = Math.min(anchorDay || d.getDate(), daysInMonth(first.getFullYear(), first.getMonth()));
  return toDateStr(new Date(first.getFullYear(), first.getMonth(), day));
}

/** Turns every scheduled item that is due (on or before today) into a real transaction. */
function runSchedules() {
  const today = todayStr();
  let created = 0;
  for (const r of state.recurring) {
    if (r.paused) continue;
    let guard = 0;
    while (r.nextDate <= today && guard++ < 1000) {
      if (r.endDate && r.nextDate > r.endDate) break;
      state.transactions.push({
        id: uid(), created: Date.now(), type: r.type, amount: r.amount,
        categoryId: r.categoryId, date: r.nextDate, note: r.note, recurringId: r.id,
      });
      r.nextDate = nextOccurrence(r.nextDate, r.frequency, r.anchorDay);
      created++;
    }
  }
  if (created) save();
  return created;
}

/** Lists scheduled items that will happen within the next `days` days. */
function upcoming(days) {
  return upcomingUntil(addDays(todayStr(), days));
}

/** Lists scheduled items due after today and on or before `limit` (YYYY-MM-DD). */
function upcomingUntil(limit) {
  const items = [];
  for (const r of state.recurring) {
    if (r.paused) continue;
    let d = r.nextDate;
    let guard = 0;
    while (d <= limit && guard++ < 100) {
      if (r.endDate && d > r.endDate) break;
      items.push({ ...r, date: d });
      d = nextOccurrence(d, r.frequency, r.anchorDay);
    }
  }
  return items.sort((a, b) => a.date.localeCompare(b.date));
}

/* ---------- Calculations ---------- */

/* A budget "month" can start on any day (e.g. payday). It is identified by the
   calendar month it starts in: with a start day of 27, "2026-09" is 27 Sep – 26 Oct. */
function startDay() {
  return Math.min(31, Math.max(1, Number(state.settings.monthStartDay) || 1));
}

function periodStart(key) {
  const [y, m] = key.split('-').map(Number);
  return toDateStr(new Date(y, m - 1, Math.min(startDay(), daysInMonth(y, m - 1))));
}

function periodEnd(key) {
  return addDays(periodStart(shiftMonth(key, 1)), -1);
}

function periodKeyFor(dateStr) {
  const key = monthKey(dateStr);
  return dateStr < periodStart(key) ? shiftMonth(key, -1) : key;
}

function txInMonth(key) {
  const start = periodStart(key), end = periodEnd(key);
  return state.transactions.filter(t => t.date >= start && t.date <= end);
}

function monthStats(key) {
  const stats = { income: 0, expense: 0, byCat: {} };
  for (const t of txInMonth(key)) {
    if (t.type === 'income') {
      stats.income += t.amount;
    } else {
      stats.expense += t.amount;
      stats.byCat[t.categoryId] = (stats.byCat[t.categoryId] || 0) + t.amount;
    }
  }
  stats.net = stats.income - stats.expense;
  return stats;
}

/** Money in the account today: the starting balance plus everything received minus everything spent. */
function currentBalance() {
  const today = todayStr();
  const net = sum(state.transactions.filter(t => t.date <= today), t => (t.type === 'income' ? t.amount : -t.amount));
  return Math.round(((Number(state.settings.openingBalance) || 0) + net) * 100) / 100;
}

const daysBetween = (a, b) => Math.round((parseDate(b) - parseDate(a)) / 864e5);

function defaultDateForMonth() {
  const today = todayStr();
  return periodKeyFor(today) === ui.month ? today : periodStart(ui.month);
}

/* ---------- Reusable pieces of markup ---------- */

function progressBar(spent, budget, color) {
  const pct = budget > 0 ? Math.min(100, (spent / budget) * 100) : 0;
  const cls = budget > 0 && spent > budget ? 'over' : pct >= 80 ? 'warn' : '';
  return `<div class="bar ${cls}" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(pct)}"><span style="width:${pct}%;background:${color}"></span></div>`;
}

function budgetRow(cat, spent) {
  const amounts = cat.budget > 0 ? `${money(spent)} / ${money(cat.budget)}` : `${money(spent)} · no limit`;
  return `<div>
    <div class="budget-head"><span class="dot" style="background:${cat.color}"></span><span>${esc(cat.name)}</span><span class="amounts">${amounts}</span></div>
    ${progressBar(spent, cat.budget, cat.color)}
  </div>`;
}

function txRow(t, withActions = true) {
  const c = catById(t.categoryId);
  const sign = t.type === 'income' ? '+' : '−';
  const actions = withActions ? `<div class="tx-actions">
      <button class="icon-btn" data-action="edit-tx" data-id="${t.id}" aria-label="Edit transaction" title="Edit">✎</button>
      <button class="icon-btn" data-action="delete-tx" data-id="${t.id}" aria-label="Delete transaction" title="Delete">✕</button>
    </div>` : '';
  return `<li class="tx">
    <span class="dot" style="background:${c.color}"></span>
    <div class="tx-main">
      <div class="tx-title">${esc(t.note || c.name)}${t.recurringId ? '<span class="tag">scheduled</span>' : ''}${t.smsHash ? '<span class="tag">SMS</span>' : ''}</div>
      <div class="tx-sub">${esc(c.name)} · ${fmtDate(t.date)}</div>
    </div>
    <div class="tx-amt ${t.type}">${sign}${money(t.amount)}</div>
    ${actions}
  </li>`;
}

function upcomingRow(r) {
  const c = catById(r.categoryId);
  const sign = r.type === 'income' ? '+' : '−';
  return `<li class="tx">
    <span class="dot" style="background:${c.color}"></span>
    <div class="tx-main">
      <div class="tx-title">${esc(r.note || c.name)}</div>
      <div class="tx-sub">${fmtDate(r.date)} · ${FREQUENCIES[r.frequency]}</div>
    </div>
    <div class="tx-amt ${r.type}">${sign}${money(r.amount)}</div>
  </li>`;
}

function donut(segments) {
  const total = sum(segments, s => s.value);
  const r = 60;
  const c = 2 * Math.PI * r;
  let offset = 0;
  const arcs = segments.map(s => {
    const len = (s.value / total) * c;
    const arc = `<circle r="${r}" cx="80" cy="80" fill="none" stroke="${s.color}" stroke-width="22"
      stroke-dasharray="${len} ${c - len}" stroke-dashoffset="${-offset}" transform="rotate(-90 80 80)">
      <title>${esc(s.label)}: ${esc(money(s.value))}</title></circle>`;
    offset += len;
    return arc;
  });
  return `<svg viewBox="0 0 160 160" class="donut" role="img" aria-label="Spending by category">
    ${arcs.join('')}
    <text x="80" y="74" text-anchor="middle" class="donut-label">Spent</text>
    <text x="80" y="94" text-anchor="middle" class="donut-value"${money(total).length > 10 ? ' style="font-size:12px"' : ''}>${esc(money(total))}</text>
  </svg>`;
}

function barChart(months) {
  const W = 340, H = 170, base = H - 22, top = 10;
  const max = Math.max(1, ...months.flatMap(m => [m.income, m.expense]));
  const groupW = W / months.length;
  const bw = Math.min(16, groupW * 0.3);
  const scale = v => (v / max) * (base - top);
  const bars = months.map((m, i) => {
    const x = i * groupW + groupW / 2;
    const hi = scale(m.income), he = scale(m.expense);
    return `<rect x="${x - bw - 1}" y="${base - hi}" width="${bw}" height="${hi}" rx="3" fill="var(--income)"><title>${monthName(m.key)} income: ${esc(money(m.income))}</title></rect>
      <rect x="${x + 1}" y="${base - he}" width="${bw}" height="${he}" rx="3" fill="var(--expense)"><title>${monthName(m.key)} spent: ${esc(money(m.expense))}</title></rect>
      <text x="${x}" y="${H - 6}" text-anchor="middle">${monthName(m.key, true)}</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" class="bars" role="img" aria-label="Income and spending over the last six months">
    <line class="grid" x1="0" x2="${W}" y1="${base}" y2="${base}"/>
    ${bars.join('')}
  </svg>
  <div class="chart-key"><span style="--key:var(--income)">Income</span><span style="--key:var(--expense)">Spent</span></div>`;
}

/* ---------- Views ---------- */

function viewDashboard() {
  const s = monthStats(ui.month);
  const expenseCats = categoriesOf('expense');
  const totalBudget = sum(expenseCats, c => c.budget || 0);
  const isEmpty = state.transactions.length === 0 && state.recurring.length === 0;

  const welcome = isEmpty ? `<section class="card welcome">
      <h2>Welcome to your budget tracker</h2>
      <p class="muted">Start by setting monthly limits for your categories, then add your expenses and income as they happen. Scheduled items such as rent or salary are added automatically when they are due.</p>
      <div class="actions">
        <button class="btn primary" data-action="add-tx">Add first transaction</button>
        <a class="btn" href="#budgets">Set up budgets</a>
        <button class="btn" data-action="sample">Try with sample data</button>
      </div>
    </section>` : '';

  const alerts = expenseCats
    .filter(c => c.budget > 0 && (s.byCat[c.id] || 0) >= c.budget * 0.8)
    .map(c => {
      const spent = s.byCat[c.id] || 0;
      const over = spent > c.budget;
      return `<div class="alert ${over ? 'danger' : 'warn'}">${over ? 'Over budget' : 'Close to the limit'}: <strong>${esc(c.name)}</strong> — ${money(spent)} of ${money(c.budget)}</div>`;
    }).join('');

  const segments = Object.entries(s.byCat)
    .map(([id, value]) => ({ value, color: catById(id).color, label: catById(id).name }))
    .sort((a, b) => b.value - a.value);

  const months = Array.from({ length: 6 }, (_, i) => {
    const key = shiftMonth(ui.month, i - 5);
    const st = monthStats(key);
    return { key, income: st.income, expense: st.expense };
  });

  const budgeted = expenseCats.filter(c => c.budget > 0 || s.byCat[c.id]);
  const recent = txInMonth(ui.month).sort(byDateDesc).slice(0, 6);
  const next = upcoming(30).slice(0, 6);
  const left = totalBudget - s.expense;

  return `${welcome}
  <section class="stats">
    <div class="stat"><div class="stat-label">Income</div><div class="stat-value pos">${money(s.income)}</div></div>
    <div class="stat"><div class="stat-label">Spent</div><div class="stat-value">${money(s.expense)}</div></div>
    <div class="stat"><div class="stat-label">Net</div><div class="stat-value ${s.net < 0 ? 'neg' : 'pos'}">${money(s.net)}</div>
      <div class="stat-sub">${s.income > 0 ? `${Math.round((s.net / s.income) * 100)}% of income saved` : 'No income yet'}</div></div>
    <div class="stat"><div class="stat-label">Budget left</div><div class="stat-value ${left < 0 ? 'neg' : ''}">${totalBudget ? money(left) : '—'}</div>
      <div class="stat-sub">${totalBudget ? `of ${money(totalBudget)} planned` : '<a href="#budgets">Set budgets</a>'}</div></div>
  </section>
  ${alerts ? `<section class="alerts">${alerts}</section>` : ''}
  <div class="grid-2">
    <section class="card">
      <h2>Spending by category</h2>
      ${segments.length ? `<div class="donut-wrap">${donut(segments)}
        <ul class="legend">${segments.map(seg => `<li><span class="dot" style="background:${seg.color}"></span>${esc(seg.label)}<span class="val">${money(seg.value)}</span><span class="pct">${Math.round((seg.value / s.expense) * 100)}%</span></li>`).join('')}</ul>
      </div>` : '<p class="empty">No spending recorded this month.</p>'}
    </section>
    <section class="card">
      <div class="card-head"><h2>Budgets</h2><a class="btn small" href="#budgets">Edit</a></div>
      ${budgeted.length ? `<div class="budget-list">${budgeted.map(c => budgetRow(c, s.byCat[c.id] || 0)).join('')}</div>` : '<p class="empty">No budgets set yet.</p>'}
    </section>
    <section class="card">
      <h2>Last 6 months</h2>
      ${barChart(months)}
    </section>
    <section class="card">
      <div class="card-head"><h2>Coming up (30 days)</h2><a class="btn small" href="#scheduled">Manage</a></div>
      ${next.length ? `<ul class="tx-list">${next.map(upcomingRow).join('')}</ul>` : '<p class="empty">Nothing scheduled. Add rent, bills or salary under Scheduled.</p>'}
    </section>
  </div>
  <section class="card">
    <div class="card-head"><h2>Recent transactions</h2><a class="btn small" href="#transactions">See all</a></div>
    ${recent.length ? `<ul class="tx-list">${recent.map(t => txRow(t)).join('')}</ul>` : '<p class="empty">No transactions this month.</p>'}
  </section>`;
}

function viewTransactions() {
  let txs = txInMonth(ui.month);
  if (ui.filterType) txs = txs.filter(t => t.type === ui.filterType);
  if (ui.filterCat) txs = txs.filter(t => t.categoryId === ui.filterCat);
  if (ui.search) {
    const q = ui.search.toLowerCase();
    txs = txs.filter(t => (t.note || '').toLowerCase().includes(q) || catById(t.categoryId).name.toLowerCase().includes(q));
  }
  txs.sort(byDateDesc);
  const totalIn = sum(txs.filter(t => t.type === 'income'), t => t.amount);
  const totalOut = sum(txs.filter(t => t.type === 'expense'), t => t.amount);
  const catOpts = state.categories.map(c => `<option value="${c.id}" ${ui.filterCat === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('');

  return `<section class="card">
    <div class="card-head"><h2>Transactions · ${monthName(ui.month)}</h2><button class="btn small" data-action="export-csv">Export CSV</button></div>
    <div class="filters">
      <input type="search" id="search" placeholder="Search notes or categories" value="${esc(ui.search)}" aria-label="Search transactions">
      <select id="filterType" aria-label="Filter by type">
        <option value="">All types</option>
        <option value="expense" ${ui.filterType === 'expense' ? 'selected' : ''}>Expenses</option>
        <option value="income" ${ui.filterType === 'income' ? 'selected' : ''}>Income</option>
      </select>
      <select id="filterCat" aria-label="Filter by category"><option value="">All categories</option>${catOpts}</select>
    </div>
    <div class="summary-line">${txs.length} transaction${txs.length === 1 ? '' : 's'} · In <span class="pos">${money(totalIn)}</span> · Out ${money(totalOut)}</div>
    ${txs.length ? `<ul class="tx-list">${txs.map(t => txRow(t)).join('')}</ul>` : '<p class="empty">No transactions match.</p>'}
  </section>`;
}

function startDayControl() {
  const opts = Array.from({ length: 31 }, (_, i) => i + 1)
    .map(d => `<option value="${d}" ${startDay() === d ? 'selected' : ''}>${d === 1 ? '1st (calendar month)' : `Day ${d}`}</option>`).join('');
  return `<label>Budget month starts on
    <select data-setting="monthStartDay">${opts}</select></label>`;
}

function viewBudgets() {
  const s = monthStats(ui.month);
  const expenseCats = categoriesOf('expense');
  const incomeCats = categoriesOf('income');
  const allocated = sum(expenseCats, c => c.budget || 0);
  const planned = state.settings.plannedIncome || 0;
  const unallocated = planned - allocated;

  const catActions = c => `<div class="be-actions">
      <button class="icon-btn" data-action="edit-cat" data-id="${c.id}" aria-label="Edit ${esc(c.name)}" title="Edit">✎</button>
      <button class="icon-btn" data-action="delete-cat" data-id="${c.id}" aria-label="Delete ${esc(c.name)}" title="Delete">✕</button>
    </div>`;

  const expenseRows = expenseCats.map(c => {
    const spent = s.byCat[c.id] || 0;
    const remaining = c.budget - spent;
    const meta = c.budget > 0
      ? (remaining >= 0 ? `${money(remaining)} left` : `<span class="neg">${money(-remaining)} over</span>`)
      : 'No limit set';
    return `<div class="budget-edit">
      <div class="be-name"><span class="dot" style="background:${c.color}"></span><span>${esc(c.name)}</span></div>
      <label><span class="sr-only">Monthly limit for ${esc(c.name)}</span>
        <input type="number" min="0" step="any" inputmode="decimal" data-budget-id="${c.id}" value="${c.budget || ''}" placeholder="No limit"></label>
      <div class="be-bar">${progressBar(spent, c.budget, c.color)}<div class="be-meta">${money(spent)} spent · ${meta}</div></div>
      ${catActions(c)}
    </div>`;
  }).join('');

  const incomeRows = incomeCats.map(c => `<div class="tx">
      <span class="dot" style="background:${c.color}"></span>
      <div class="tx-main"><div class="tx-title">${esc(c.name)}</div></div>
      <div class="tx-amt income">${money(sum(txInMonth(ui.month).filter(t => t.categoryId === c.id), t => t.amount))}</div>
      ${catActions(c)}
    </div>`).join('');

  return `<section class="card">
    <h2>Plan your month</h2>
    <p class="muted">Enter what you expect to earn each month, then give each category a monthly limit. Limits repeat every month; the bars show ${monthName(ui.month)}. Set the start day to your payday so each budget month begins with your salary.</p>
    <div class="plan-grid">
      ${startDayControl()}
      <label>Expected monthly income
        <input type="number" min="0" step="any" inputmode="decimal" data-setting="plannedIncome" value="${planned || ''}" placeholder="0"></label>
      <div class="stat"><div class="stat-label">Allocated to categories</div><div class="stat-value">${money(allocated)}</div></div>
      <div class="stat"><div class="stat-label">${unallocated >= 0 ? 'Left to allocate' : 'Over-allocated by'}</div>
        <div class="stat-value ${unallocated < 0 ? 'neg' : 'pos'}">${money(Math.abs(unallocated))}</div></div>
    </div>
  </section>
  <section class="card">
    <div class="card-head"><h2>Expense categories</h2><button class="btn small" data-action="add-cat" data-kind="expense">+ Category</button></div>
    ${expenseRows || '<p class="empty">No expense categories.</p>'}
  </section>
  <section class="card">
    <div class="card-head"><h2>Income categories</h2><button class="btn small" data-action="add-cat" data-kind="income">+ Category</button></div>
    ${incomeRows ? `<div class="tx-list">${incomeRows}</div>` : '<p class="empty">No income categories.</p>'}
  </section>`;
}

function viewScheduled() {
  const rules = [...state.recurring].sort((a, b) => (a.paused - b.paused) || a.nextDate.localeCompare(b.nextDate));
  const next = upcoming(30);
  const dueOut = sum(next.filter(r => r.type === 'expense'), r => r.amount);
  const dueIn = sum(next.filter(r => r.type === 'income'), r => r.amount);

  const ruleRows = rules.map(r => {
    const c = catById(r.categoryId);
    const sign = r.type === 'income' ? '+' : '−';
    return `<li class="tx">
      <span class="dot" style="background:${c.color}"></span>
      <div class="tx-main">
        <div class="tx-title">${esc(r.note || c.name)}${r.paused ? '<span class="tag">paused</span>' : ''}</div>
        <div class="tx-sub">${FREQUENCIES[r.frequency]} · ${esc(c.name)} · ${r.paused ? 'paused' : `next ${fmtDate(r.nextDate)}`}${r.endDate ? ` · ends ${fmtDate(r.endDate)}` : ''}</div>
      </div>
      <div class="tx-amt ${r.type}">${sign}${money(r.amount)}</div>
      <div class="tx-actions">
        <button class="icon-btn" data-action="toggle-rule" data-id="${r.id}" aria-label="${r.paused ? 'Resume' : 'Pause'}" title="${r.paused ? 'Resume' : 'Pause'}">${r.paused ? '▶' : '❚❚'}</button>
        <button class="icon-btn" data-action="edit-rule" data-id="${r.id}" aria-label="Edit" title="Edit">✎</button>
        <button class="icon-btn" data-action="delete-rule" data-id="${r.id}" aria-label="Delete" title="Delete">✕</button>
      </div>
    </li>`;
  }).join('');

  return `<section class="card">
    <div class="card-head"><h2>Scheduled payments & income</h2><button class="btn small primary" data-action="add-rule">+ Schedule</button></div>
    <p class="muted" style="margin-bottom:12px">Things that repeat, such as rent, bills, subscriptions or salary. Each one is added to your transactions automatically on its due date.</p>
    ${ruleRows ? `<ul class="tx-list">${ruleRows}</ul>` : '<p class="empty">Nothing scheduled yet.</p>'}
  </section>
  <section class="card">
    <h2>Next 30 days</h2>
    <div class="summary-line">Expected in <span class="pos">${money(dueIn)}</span> · Expected out ${money(dueOut)}</div>
    ${next.length ? `<ul class="tx-list">${next.map(upcomingRow).join('')}</ul>` : '<p class="empty">Nothing due in the next 30 days.</p>'}
  </section>`;
}

function viewForecast() {
  const today = todayStr();
  const end = ui.forecast === 'period' ? periodEnd(periodKeyFor(today)) : addDays(today, Number(ui.forecast));
  const items = upcomingUntil(end);
  const balance = currentBalance();
  const scheduledOut = sum(items.filter(i => i.type === 'expense'), i => i.amount);
  const scheduledIn = sum(items.filter(i => i.type === 'income'), i => i.amount);
  const afterExpenses = balance - scheduledOut;
  const afterAll = afterExpenses + scheduledIn;
  const days = daysBetween(today, end) + 1;
  const perDay = afterExpenses / days;

  // Walk through the scheduled items in date order to show the balance after each one.
  let running = balance;
  let lowest = { value: balance, date: today };
  const rows = items.map(i => {
    running += i.type === 'income' ? i.amount : -i.amount;
    if (running < lowest.value) lowest = { value: running, date: i.date };
    const c = catById(i.categoryId);
    return `<li class="tx">
      <span class="dot" style="background:${c.color}"></span>
      <div class="tx-main">
        <div class="tx-title">${esc(i.note || c.name)}</div>
        <div class="tx-sub">${fmtDate(i.date)} · ${FREQUENCIES[i.frequency]}</div>
      </div>
      <div>
        <div class="tx-amt ${i.type}">${i.type === 'income' ? '+' : '−'}${money(i.amount)}</div>
        <div class="tx-bal">${money(running)} left</div>
      </div>
    </li>`;
  }).join('');

  const horizons = [['period', `Until ${fmtDate(periodEnd(periodKeyFor(today)))} (end of budget month)`], ['30', 'Next 30 days'], ['60', 'Next 60 days'], ['90', 'Next 90 days']]
    .map(([v, label]) => `<option value="${v}" ${ui.forecast === v ? 'selected' : ''}>${label}</option>`).join('');

  return `<section class="card">
    <div class="card-head"><h2>What you'll have left</h2></div>
    <p class="muted" style="margin-bottom:12px">Your balance now minus every scheduled payment due before the date you pick.</p>
    <label>Look ahead<select id="forecastHorizon">${horizons}</select></label>
  </section>
  <section class="stats">
    <div class="stat"><div class="stat-label">Balance now</div><div class="stat-value">${money(balance)}</div>
      <div class="stat-sub"><a href="#forecast" data-action="set-balance">Doesn't match your bank? Correct it</a></div></div>
    <div class="stat"><div class="stat-label">Scheduled payments</div><div class="stat-value">${scheduledOut ? `−${money(scheduledOut)}` : money(0)}</div>
      <div class="stat-sub">${items.filter(i => i.type === 'expense').length} due by ${fmtDate(end)}</div></div>
    <div class="stat forecast-result"><div class="stat-label">Left after scheduled payments</div>
      <div class="stat-value ${afterExpenses < 0 ? 'neg' : 'pos'}">${money(afterExpenses)}</div>
      <div class="stat-sub">${afterExpenses > 0 ? `≈ ${money(perDay)} a day for ${days} day${days === 1 ? '' : 's'}` : 'Not enough to cover them'}</div></div>
    ${scheduledIn ? `<div class="stat"><div class="stat-label">Including expected income</div>
      <div class="stat-value ${afterAll < 0 ? 'neg' : ''}">${money(afterAll)}</div>
      <div class="stat-sub">+${money(scheduledIn)} scheduled to come in</div></div>` : ''}
  </section>
  ${lowest.value < 0 ? `<section class="alerts"><div class="alert danger">Your balance would drop to <strong>${money(lowest.value)}</strong> on ${fmtDate(lowest.date)}. Move money in or reschedule a payment before then.</div></section>` : ''}
  <section class="card">
    <div class="card-head"><h2>Coming up until ${fmtDate(end)}</h2><button class="btn small" data-action="add-rule">+ Schedule</button></div>
    ${rows ? `<ul class="tx-list">${rows}</ul>` : `<p class="empty">No scheduled payments before ${fmtDate(end)}. Add rent, bills or subscriptions under Scheduled to see what you'll have left after them.</p>`}
  </section>`;
}

function viewGoals() {
  const cards = state.goals.map(g => {
    const pct = g.target > 0 ? Math.min(100, (g.saved / g.target) * 100) : 0;
    const remaining = Math.max(0, g.target - g.saved);
    let plan = '';
    if (remaining === 0) {
      plan = '<span class="pos">Goal reached 🎉</span>';
    } else if (g.deadline) {
      const now = new Date();
      const end = parseDate(g.deadline);
      const monthsLeft = (end.getFullYear() - now.getFullYear()) * 12 + (end.getMonth() - now.getMonth());
      plan = monthsLeft > 0
        ? `Save ${money(remaining / monthsLeft)} a month to reach it by ${fmtDate(g.deadline)}`
        : `<span class="neg">Deadline ${fmtDate(g.deadline)} — ${money(remaining)} still needed</span>`;
    } else {
      plan = `${money(remaining)} to go`;
    }
    return `<section class="card goal">
      <div class="card-head" style="margin:0"><h3>${esc(g.name)}</h3>
        <div class="tx-actions">
          <button class="icon-btn" data-action="edit-goal" data-id="${g.id}" aria-label="Edit goal" title="Edit">✎</button>
          <button class="icon-btn" data-action="delete-goal" data-id="${g.id}" aria-label="Delete goal" title="Delete">✕</button>
        </div>
      </div>
      <div class="goal-nums"><strong>${money(g.saved)}</strong><span class="muted">of ${money(g.target)} · ${Math.round(pct)}%</span></div>
      <div class="bar"><span style="width:${pct}%;background:${g.color || 'var(--accent)'}"></span></div>
      <div class="muted" style="font-size:.88rem">${plan}</div>
      <div class="goal-actions">
        <button class="btn small" data-action="contribute" data-id="${g.id}">+ Add money</button>
        <button class="btn small" data-action="withdraw" data-id="${g.id}">− Take out</button>
      </div>
    </section>`;
  }).join('');

  return `<section class="card">
    <div class="card-head"><h2>Savings goals</h2><button class="btn small primary" data-action="add-goal">+ Goal</button></div>
    <p class="muted">Save toward things that matter, such as an emergency fund, a trip or a new laptop. Set a deadline to see how much to put aside each month.</p>
  </section>
  ${cards ? `<div class="goals">${cards}</div>` : '<section class="card"><p class="empty">No goals yet.</p></section>'}`;
}

function viewSettings() {
  const currencyOpts = CURRENCIES.map(c => `<option value="${c}" ${state.settings.currency === c ? 'selected' : ''}>${c}</option>`).join('');
  return `<section class="card settings-list">
    <h2>Settings</h2>
    <div class="setting-row">
      <div><div>Currency</div><div class="desc">Used to display every amount.</div></div>
      <select data-setting="currency" aria-label="Currency">${currencyOpts}</select>
    </div>
    <div class="setting-row">
      <div><div>Budget month</div><div class="desc">Start each budget month on your payday, e.g. day 27 → 27th to 26th. Applies to the dashboard, transactions and budgets.</div></div>
      <div>${startDayControl()}</div>
    </div>
    <div class="setting-row">
      <div><div>Back up your data</div><div class="desc">Your data lives only in this browser. Download a backup to keep it safe or move it to another device.</div></div>
      <div class="goal-actions"><button class="btn" data-action="export-json">Download backup</button><button class="btn" data-action="import-json">Restore backup</button></div>
    </div>
    <div class="setting-row">
      <div><div>Export transactions</div><div class="desc">A CSV file you can open in Excel or Google Sheets.</div></div>
      <button class="btn" data-action="export-csv-all">Export CSV</button>
    </div>
    <div class="setting-row">
      <div><div>Bank SMS import</div><div class="desc">Add card payments automatically from your bank's text messages with an iPhone Shortcut. Messages are read on this device only; the card number and balance are never saved.</div></div>
      <div class="goal-actions"><button class="btn" data-action="sms-test">Paste a message</button><button class="btn" data-action="copy-sms-link">Copy Shortcut link</button></div>
    </div>
    ${Object.keys(state.merchantRules).length ? `<div class="setting-row">
      <div><div>Remembered merchants</div><div class="desc">${Object.keys(state.merchantRules).length} merchant${Object.keys(state.merchantRules).length === 1 ? '' : 's'} will use the category you last picked for them.</div></div>
      <button class="btn" data-action="forget-rules">Forget them</button>
    </div>` : ''}
    <div class="setting-row">
      <div><div>Sample data</div><div class="desc">Replace everything with example data to explore the app.</div></div>
      <button class="btn" data-action="sample">Load sample data</button>
    </div>
    <div class="setting-row">
      <div><div>Reset</div><div class="desc">Delete all transactions, budgets, schedules and goals.</div></div>
      <button class="btn danger" data-action="reset">Delete everything</button>
    </div>
  </section>`;
}

const VIEW_RENDERERS = {
  dashboard: viewDashboard,
  transactions: viewTransactions,
  budgets: viewBudgets,
  scheduled: viewScheduled,
  forecast: viewForecast,
  goals: viewGoals,
  settings: viewSettings,
};

/* ---------- Rendering ---------- */

const $view = document.getElementById('view');

function render() {
  const active = document.activeElement;
  const focusId = active && $view.contains(active) ? active.id || null : null;
  const caret = focusId && active.selectionStart != null ? active.selectionStart : null;

  document.querySelectorAll('#tabs a').forEach(a => a.classList.toggle('active', a.dataset.view === ui.view));
  document.getElementById('monthNav').hidden = !MONTH_VIEWS.includes(ui.view);
  document.getElementById('monthLabel').textContent = monthName(ui.month);
  $view.innerHTML = VIEW_RENDERERS[ui.view]();

  // Keep typing smooth in the search box after a re-render.
  if (focusId) {
    const el = document.getElementById(focusId);
    if (el) {
      el.focus();
      if (caret != null && el.setSelectionRange) el.setSelectionRange(caret, caret);
    }
  }
}

let toastTimer;
/** Shows a short message; pass `actions` ({ label, onClick } or a list of them) to add buttons such as Undo. */
function toast(msg, actions) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  const list = actions ? [].concat(actions) : [];
  for (const action of list) {
    const btn = document.createElement('button');
    btn.className = 'toast-btn';
    btn.textContent = action.label;
    btn.addEventListener('click', () => {
      el.hidden = true;
      action.onClick();
    });
    el.appendChild(btn);
  }
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, list.length ? 8000 : 2600);
}

/* ---------- Modal forms ---------- */

const $modal = document.getElementById('modal');
const $form = document.getElementById('modalForm');
let modalSubmit = null;

function openModal(title, body, onSubmit, submitLabel = 'Save') {
  $form.innerHTML = `<h2>${esc(title)}</h2>
    <div class="form-body">${body}</div>
    <div class="form-error" id="formError" hidden></div>
    <div class="form-actions">
      <button type="button" class="btn" data-close>Cancel</button>
      <button type="submit" class="btn primary">${esc(submitLabel)}</button>
    </div>`;
  modalSubmit = onSubmit;
  $modal.showModal();
  const first = $form.querySelector('input:not([type=radio]), select, textarea');
  if (first) first.focus();
}

function formError(msg) {
  const el = document.getElementById('formError');
  el.textContent = msg;
  el.hidden = false;
  return false;
}

$form.addEventListener('submit', e => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData($form));
  if (modalSubmit && modalSubmit(data) !== false) {
    $modal.close();
    save();
    render();
  }
});

$form.addEventListener('click', e => {
  if (e.target.closest('[data-close]')) $modal.close();
});

function catOptions(kind, selected) {
  return categoriesOf(kind).map(c => `<option value="${c.id}" ${c.id === selected ? 'selected' : ''}>${esc(c.name)}</option>`).join('')
    || '<option value="">Uncategorized</option>';
}

function typeToggle(type) {
  return `<div class="seg" role="radiogroup" aria-label="Type">
    <label><input type="radio" name="type" value="expense" ${type === 'expense' ? 'checked' : ''}><span>Expense</span></label>
    <label><input type="radio" name="type" value="income" ${type === 'income' ? 'checked' : ''}><span>Income</span></label>
  </div>`;
}

function bindTypeToggle() {
  $form.querySelectorAll('input[name=type]').forEach(radio => radio.addEventListener('change', () => {
    $form.querySelector('[name=categoryId]').innerHTML = catOptions(radio.value, '');
  }));
}

function parseAmount(v) {
  const n = parseFloat(String(v).replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

function txForm(tx) {
  const t = tx || { type: 'expense', amount: '', categoryId: '', date: defaultDateForMonth(), note: '' };
  const repeatOpts = Object.entries(FREQUENCIES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
  const body = `${typeToggle(t.type)}
    <div class="form-row">
      <label>Amount<input name="amount" type="number" min="0" step="any" inputmode="decimal" required value="${t.amount}"></label>
      <label>Date<input name="date" type="date" required value="${t.date}"></label>
    </div>
    <label>Category<select name="categoryId">${catOptions(t.type, t.categoryId)}</select></label>
    <label>Note<input name="note" type="text" maxlength="120" value="${esc(t.note)}" placeholder="e.g. Weekly groceries"></label>
    ${tx ? '' : `<label>Repeat<select name="repeat"><option value="">Doesn't repeat</option>${repeatOpts}</select></label>`}`;

  openModal(tx ? 'Edit transaction' : 'Add transaction', body, d => {
    const amount = parseAmount(d.amount);
    if (!amount) return formError('Enter an amount greater than zero.');
    if (!d.date) return formError('Pick a date.');
    const fields = { type: d.type, amount, categoryId: d.categoryId, note: d.note.trim() };

    if (tx) {
      // Remember the category chosen for a bank-SMS merchant so future messages use it.
      if (tx.merchant && !isMixedMerchant(tx.merchant) && fields.categoryId !== tx.categoryId) state.merchantRules[merchantKey(tx.merchant)] = fields.categoryId;
      Object.assign(tx, fields, { date: d.date });
      toast('Transaction updated');
    } else if (d.repeat) {
      state.recurring.push({
        id: uid(), ...fields, frequency: d.repeat, startDate: d.date, nextDate: d.date,
        anchorDay: parseDate(d.date).getDate(), paused: false, endDate: '',
      });
      runSchedules();
      toast(`Scheduled ${FREQUENCIES[d.repeat].toLowerCase()} from ${fmtDate(d.date)}`);
    } else {
      state.transactions.push({ id: uid(), created: Date.now(), ...fields, date: d.date });
      toast('Transaction added');
    }
  });
  bindTypeToggle();
}

function ruleForm(rule) {
  const r = rule || { type: 'expense', amount: '', categoryId: '', frequency: 'monthly', nextDate: todayStr(), note: '', endDate: '' };
  const freqOpts = Object.entries(FREQUENCIES).map(([k, v]) => `<option value="${k}" ${r.frequency === k ? 'selected' : ''}>${v}</option>`).join('');
  const body = `${typeToggle(r.type)}
    <label>Name<input name="note" type="text" maxlength="120" value="${esc(r.note)}" placeholder="e.g. Rent, Netflix, Salary"></label>
    <div class="form-row">
      <label>Amount<input name="amount" type="number" min="0" step="any" inputmode="decimal" required value="${r.amount}"></label>
      <label>Repeats<select name="frequency">${freqOpts}</select></label>
    </div>
    <label>Category<select name="categoryId">${catOptions(r.type, r.categoryId)}</select></label>
    <div class="form-row">
      <label>${rule ? 'Next date' : 'First date'}<input name="nextDate" type="date" required value="${r.nextDate}"></label>
      <label>End date (optional)<input name="endDate" type="date" value="${r.endDate || ''}"></label>
    </div>`;

  openModal(rule ? 'Edit scheduled item' : 'Schedule a payment or income', body, d => {
    const amount = parseAmount(d.amount);
    if (!amount) return formError('Enter an amount greater than zero.');
    if (!d.nextDate) return formError('Pick a date.');
    if (d.endDate && d.endDate < d.nextDate) return formError('The end date must be after the first date.');
    const fields = {
      type: d.type, amount, categoryId: d.categoryId, note: d.note.trim(), frequency: d.frequency,
      nextDate: d.nextDate, endDate: d.endDate || '', anchorDay: parseDate(d.nextDate).getDate(),
    };
    if (rule) Object.assign(rule, fields);
    else state.recurring.push({ id: uid(), startDate: d.nextDate, paused: false, ...fields });
    const n = runSchedules();
    toast(n ? `Saved · ${n} due transaction${n === 1 ? '' : 's'} added` : 'Schedule saved');
  });
  bindTypeToggle();
}

function categoryForm(cat, kind) {
  const c = cat || { name: '', color: COLORS[state.categories.length % COLORS.length], budget: 0, kind };
  const body = `<div class="form-row">
      <label>Name<input name="name" type="text" maxlength="40" required value="${esc(c.name)}"></label>
      <label>Colour<input name="color" type="color" value="${c.color}"></label>
    </div>
    ${c.kind === 'expense' ? `<label>Monthly limit (optional)<input name="budget" type="number" min="0" step="any" inputmode="decimal" value="${c.budget || ''}"></label>` : ''}`;

  openModal(cat ? 'Edit category' : `New ${c.kind} category`, body, d => {
    const name = d.name.trim();
    if (!name) return formError('Give the category a name.');
    const fields = { name, color: d.color, budget: c.kind === 'expense' ? (parseFloat(d.budget) || 0) : 0 };
    if (cat) Object.assign(cat, fields);
    else state.categories.push({ id: uid(), kind: c.kind, ...fields });
    toast('Category saved');
  });
}

function goalForm(goal) {
  const g = goal || { name: '', target: '', saved: '', deadline: '', color: COLORS[state.goals.length % COLORS.length] };
  const body = `<div class="form-row">
      <label>Goal<input name="name" type="text" maxlength="60" required value="${esc(g.name)}" placeholder="e.g. Emergency fund"></label>
      <label>Colour<input name="color" type="color" value="${g.color}"></label>
    </div>
    <div class="form-row">
      <label>Target amount<input name="target" type="number" min="0" step="any" inputmode="decimal" required value="${g.target}"></label>
      <label>Already saved<input name="saved" type="number" min="0" step="any" inputmode="decimal" value="${g.saved}"></label>
    </div>
    <label>Target date (optional)<input name="deadline" type="date" value="${g.deadline || ''}"></label>`;

  openModal(goal ? 'Edit goal' : 'New savings goal', body, d => {
    const target = parseAmount(d.target);
    if (!d.name.trim()) return formError('Give the goal a name.');
    if (!target) return formError('Enter a target amount.');
    const fields = { name: d.name.trim(), target, saved: Math.max(0, parseFloat(d.saved) || 0), deadline: d.deadline, color: d.color };
    if (goal) Object.assign(goal, fields);
    else state.goals.push({ id: uid(), ...fields });
    toast('Goal saved');
  });
}

function goalMoneyForm(goal, direction) {
  const body = `<label>Amount<input name="amount" type="number" min="0" step="any" inputmode="decimal" required></label>`;
  openModal(direction > 0 ? `Add to ${goal.name}` : `Take out of ${goal.name}`, body, d => {
    const amount = parseAmount(d.amount);
    if (!amount) return formError('Enter an amount greater than zero.');
    goal.saved = Math.max(0, Math.round((goal.saved + direction * amount) * 100) / 100);
    toast(direction > 0 ? 'Nice — saved!' : 'Updated');
  }, direction > 0 ? 'Add' : 'Take out');
}

/* ---------- Bank SMS import ----------
   An iPhone Shortcut opens the app with "#sms=<message text>". The message is read
   here, on the device. Only the amount, merchant, date and type are kept — never
   the card number or the balance. The part after "#" is never sent to the server. */

const SMS_CURRENCY = '(AED|DHS?|USD|EUR|GBP|SAR|QAR|OMR|KWD|BHD|INR|PKR|EGP|CAD|AUD|JPY|CNY|TRY|CHF)';

// Checked in order, so more specific names ("careem food") come before general ones ("careem").
const MERCHANT_KEYWORDS = {
  Groceries: ['supermarket', 'supermark', 'hypermarket', 'grocery', 'grocer', 'baqala', 'carrefour', 'lulu', 'spinneys', 'waitrose', 'choithram', 'union coop', 'kibsons', 'noon minutes', 'instashop', 'meat', 'butcher', 'madina mini', 'mini mart'],
  'Dining out': ['talabat', 'deliveroo', 'careem food', 'noon food', 'zomato', 'starbucks', 'costa', 'tim hortons', 'mcdonald', 'kfc', 'burger', 'pizza', 'restaurant', 'cafe', 'coffee', 'shawarma', 'falafel', 'falafil', 'sweets', 'bakery'],
  Transport: ['careem', 'uber', 'salik', 'rta', 'nol card', 'enoc', 'adnoc', 'emarat', 'eppco', 'parking', 'taxi', 'petrol'],
  Utilities: ['dewa', 'sewa', 'addc', 'fewa', 'etisalat', 'virgin mobile', 'empower', 'e& '],
  Health: ['pharmacy', 'aster', 'boots', 'clinic', 'hospital', 'medical', 'dental'],
  Entertainment: ['netflix', 'spotify', 'apple.com', 'itunes', 'osn', 'shahid', 'vox', 'reel cinema', 'novo cinema', 'playstation', 'steam', 'youtube'],
  Shopping: ['amazon', 'noon', 'namshi', 'ikea', 'centrepoint', 'max fashion', 'h&m', 'zara', 'shein', 'temu', 'daiso', 'dragon mart', 'landmark', 'brands for less', 'adidas', 'nike', 'splash', 'home centre'],
  Education: ['udemy', 'coursera', 'bookstore', 'university', 'school'],
};

// Delivery apps that sell both restaurant meals and groceries: never auto-learn a category
// for them, and offer a one-tap switch when one of their payments arrives.
const MIXED_MERCHANTS = ['talabat', 'delivery hero', 'deliveroo', 'careem food'];
const isMixedMerchant = name => MIXED_MERCHANTS.some(w => String(name || '').toLowerCase().includes(w));

function hashText(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

const merchantKey = name => name.toLowerCase().replace(/[^a-z]+/g, ' ').trim().split(' ').slice(0, 3).join(' ');

/** "ISTANBUL SUPERMARKET, SHARJAH" → "Istanbul Supermarket" */
function tidyMerchant(raw) {
  let name = raw.trim();
  if (name.includes(',')) name = name.slice(0, name.lastIndexOf(',')).trim() || name;
  if (name === name.toUpperCase()) {
    name = name.toLowerCase().replace(/(^|[\s(&-])([a-z])/g, (_, p, c) => p + c.toUpperCase());
  }
  return name.slice(0, 60);
}

/** Uses a date written in the message (UAE style, day first) or else today. */
function smsDate(text) {
  const today = todayStr();
  let found = null;
  let m = text.match(/\b(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})\b/);
  if (m) {
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    const d = new Date(y, Number(m[2]) - 1, Number(m[1]));
    if (d.getMonth() === Number(m[2]) - 1) found = toDateStr(d);
  } else {
    m = text.match(/\b(\d{1,2})[\s-]?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[\s,-]*(\d{4})?\b/i);
    if (m) {
      const month = 'janfebmaraprmayjunjulaugsepoctnovdec'.indexOf(m[2].toLowerCase()) / 3;
      const d = new Date(m[3] ? Number(m[3]) : new Date().getFullYear(), month, Number(m[1]));
      if (d.getMonth() === month) found = toDateStr(d);
    }
  }
  return found && found <= today ? found : today;
}

function guessCategory(merchant, type, text = '') {
  const learned = merchant && state.merchantRules[merchantKey(merchant)];
  if (learned && state.categories.some(c => c.id === learned)) return learned;
  const pool = categoriesOf(type);
  if (type === 'income' && /\bsalary\b/i.test(text)) {
    const salary = pool.find(c => /salary/i.test(c.name));
    if (salary) return salary.id;
  }
  if (type === 'expense' && merchant) {
    const name = merchant.toLowerCase();
    for (const [catName, words] of Object.entries(MERCHANT_KEYWORDS)) {
      const cat = pool.find(c => c.name === catName);
      if (cat && words.some(w => name.includes(w))) return cat.id;
    }
  }
  return (pool.find(c => /other/i.test(c.name)) || pool[0] || { id: '' }).id;
}

/** Reads a bank SMS such as "Purchase of AED 39.99 with Debit Card ending 1234 at TALABAT, DUBAI. Avl Balance is AED 500.00." */
function parseBankSms(raw) {
  const text = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!text) return { error: 'The message is empty.' };
  if (/\b(otp|one[- ]time|verification code|passcode|password)\b/i.test(text)) return { error: 'This looks like a security code, not a payment.' };
  if (/\b(declined|failed|unsuccessful|not processed)\b/i.test(text)) return { error: 'This payment did not go through, so nothing was added.' };

  // The first amount is the transaction; a later one is usually the balance.
  let currency, amountText;
  let m = text.match(new RegExp(`\\b${SMS_CURRENCY}\\.?\\s?(\\d[\\d,]*(?:\\.\\d+)?)`, 'i'));
  if (m) {
    [, currency, amountText] = m;
  } else {
    m = text.match(new RegExp(`(\\d[\\d,]*(?:\\.\\d+)?)\\s?${SMS_CURRENCY}\\b`, 'i'));
    if (m) [, amountText, currency] = m;
  }
  if (!m) return { error: "Couldn't find an amount in this message." };
  currency = currency.toUpperCase().startsWith('DH') ? 'AED' : currency.toUpperCase();
  const amount = parseAmount(amountText);
  if (!amount) return { error: "Couldn't read the amount." };

  const spent = /\b(purchase|debited|spent|paid|payment|withdrawn|withdrawal|charged|deducted)\b/i.test(text);
  const received = /\b(credited|received|deposited|salary|cashback)\b/i.test(text);
  const refund = /\b(refund(ed)?|reversal|reversed)\b/i.test(text);
  if (!spent && !received && !refund) return { error: "Couldn't tell whether money was spent or received." };
  const type = refund || (received && !spent) ? 'income' : 'expense';

  const stop = '(?=\\.\\s|\\.$|\\s+on\\s+\\d|\\s+(?:avl|available|bal|balance|ref|with|using|via)\\b|$)';
  const mm = text.match(new RegExp(`\\bat\\s+(?!\\d)(.+?)${stop}`, 'i'))
    || text.match(new RegExp(`\\b(?:to|from)\\s+(?!your\\b|card\\b|a/c\\b|account\\b)(.+?)${stop}`, 'i'));
  const merchant = mm ? tidyMerchant(mm[1]) : '';

  return { type, amount, currency, merchant, date: smsDate(text), categoryId: guessCategory(merchant, type, text), hash: hashText(text) };
}

/** Saves a parsed message as a transaction. Returns null if that message was already added. */
function addSmsTransaction(p) {
  if (state.transactions.some(t => t.smsHash === p.hash)) return null;
  const tx = {
    id: uid(), created: Date.now(), type: p.type, amount: p.amount, categoryId: p.categoryId,
    date: p.date, note: p.merchant, merchant: p.merchant, smsHash: p.hash,
  };
  if (p.currency !== state.settings.currency) tx.note = `${p.merchant} (${p.currency} ${p.amount.toFixed(2)})`.trim();
  state.transactions.push(tx);
  save();
  return tx;
}

function announceSmsTransaction(tx, p) {
  const msg = `${tx.type === 'income' ? 'Received' : 'Added'} ${money(tx.amount)}${tx.merchant ? ` · ${tx.merchant}` : ''} → ${catById(tx.categoryId).name}`;
  const actions = [{
    label: 'Undo',
    onClick: () => {
      state.transactions = state.transactions.filter(t => t.id !== tx.id);
      save();
      render();
      toast('Removed');
    },
  }];
  if (tx.type === 'expense' && isMixedMerchant(tx.merchant)) {
    const current = catById(tx.categoryId).name;
    const other = categoriesOf('expense').find(c => c.name === (current === 'Groceries' ? 'Dining out' : 'Groceries'));
    if (other) {
      actions.unshift({
        label: other.name,
        onClick: () => {
          tx.categoryId = other.id;
          save();
          render();
          toast(`Moved to ${other.name}`);
        },
      });
    }
  }
  toast(p.currency !== state.settings.currency ? `${msg} (message was in ${p.currency})` : msg, actions);
}

/** Handles "#import=…" links that carry a batch of past transactions
 * as base64 JSON: { t: [[date, "e"|"i", amount, merchant, categoryName, note?], …] }.
 * Rows already in the app (same date, type, amount and merchant) are skipped. */
/** Reads the rows from a "#import=" / "#update=" link, or returns null if the link is damaged. */
function decodeLinkRows(encoded) {
  try {
    const bytes = Uint8Array.from(atob(decodeURIComponent(encoded).replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
    const rows = JSON.parse(new TextDecoder().decode(bytes)).t;
    return Array.isArray(rows) ? rows : null;
  } catch {
    return null;
  }
}

/** Handles "#update=…" links that re-categorise existing transactions:
 * { t: [[date, amount, merchant, categoryName, note?], …] }, matched on date, amount and merchant. */
function handleIncomingUpdate() {
  const m = location.hash.match(/^#update=([\s\S]*)$/);
  if (!m) return null;
  history.replaceState(null, '', `${location.pathname}${location.search}#transactions`);
  const rows = decodeLinkRows(m[1]);
  if (!rows) return () => toast('This update link is damaged. Copy the whole link and try again.');
  if (!confirm(`Update ${rows.length} transactions?`)) return null;

  let changed = 0;
  for (const [date, amount, merchant, catName, note] of rows) {
    const name = String(merchant || '').toLowerCase();
    const tx = state.transactions.find(t => t.date === date && Math.abs(t.amount - amount) < 0.005
      && (t.merchant || t.note || '').toLowerCase() === name);
    const cat = state.categories.find(c => c.name.toLowerCase() === String(catName).toLowerCase());
    if (!tx || !cat) continue;
    tx.categoryId = cat.id;
    if (note) tx.note = note;
    changed++;
  }
  save();
  const missing = rows.length - changed;
  return () => toast(`Updated ${changed} transaction${changed === 1 ? '' : 's'}${missing ? ` · ${missing} not found` : ''}`);
}

function handleIncomingImport() {
  const m = location.hash.match(/^#import=([\s\S]*)$/);
  if (!m) return null;
  history.replaceState(null, '', `${location.pathname}${location.search}#transactions`);
  const rows = decodeLinkRows(m[1]);
  if (!rows) return () => toast('This import link is damaged. Copy the whole link and try again.');
  if (!confirm(`Add ${rows.length} past transactions to your budget?`)) return null;

  let added = 0;
  for (const [date, kind, amount, merchant, catName, note] of rows) {
    const type = kind === 'i' ? 'income' : 'expense';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !(amount > 0)) continue;
    const name = String(merchant || '').toLowerCase();
    const exists = state.transactions.some(t => t.date === date && t.type === type
      && Math.abs(t.amount - amount) < 0.005 && (t.merchant || t.note || '').toLowerCase() === name);
    if (exists) continue;
    const cat = categoriesOf(type).find(c => c.name.toLowerCase() === String(catName).toLowerCase());
    state.transactions.push({
      id: uid(), created: Date.now(), type, amount, categoryId: cat ? cat.id : guessCategory(merchant, type),
      date, note: note || merchant, merchant,
    });
    added++;
  }
  save();
  const skipped = rows.length - added;
  return () => toast(`Imported ${added} transaction${added === 1 ? '' : 's'}${skipped ? ` · ${skipped} already there` : ''}`);
}

/** Handles "#sms=…" links from the Shortcut. Returns a function that shows the result, or null. */
function handleIncomingSms() {
  const m = location.hash.match(/^#sms=([\s\S]*)$/);
  if (!m) return null;
  let text = m[1];
  try { text = decodeURIComponent(text.replace(/\+/g, ' ')); } catch { /* keep the raw text */ }
  // Take the message out of the address bar straight away.
  history.replaceState(null, '', `${location.pathname}${location.search}#dashboard`);
  const p = parseBankSms(text);
  if (p.error) return () => toast(p.error);
  const tx = addSmsTransaction(p);
  ui.month = periodKeyFor(p.date);
  return tx ? () => announceSmsTransaction(tx, p) : () => toast('This message was already added.');
}

/* ---------- Import / export ---------- */

function download(filename, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportCsv(txs, filename) {
  const cell = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [['Date', 'Type', 'Category', 'Amount', 'Note', 'Scheduled']]
    .concat([...txs].sort((a, b) => a.date.localeCompare(b.date)).map(t => [
      t.date, t.type, catById(t.categoryId).name, t.amount.toFixed(2), t.note || '', t.recurringId ? 'yes' : '',
    ]));
  download(filename, rows.map(r => r.map(cell).join(',')).join('\n'), 'text/csv');
}

document.getElementById('importFile').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const next = normalize(JSON.parse(await file.text()));
    if (!confirm('Restoring replaces all current data with the backup. Continue?')) return;
    state = next;
    runSchedules();
    save();
    render();
    toast('Backup restored');
  } catch (err) {
    alert(`Could not restore: ${err.message}`);
  }
});

/* ---------- Sample data ---------- */

function loadSampleData() {
  state = defaultState();
  const id = name => state.categories.find(c => c.name === name).id;
  const limits = { Housing: 1200, Groceries: 450, Transport: 160, Utilities: 200, 'Dining out': 180, Health: 100, Entertainment: 120, Shopping: 200, Education: 80, Other: 60 };
  for (const [name, budget] of Object.entries(limits)) state.categories.find(c => c.name === name).budget = budget;
  state.settings.plannedIncome = 4000;

  const now = new Date();
  const start = toDateStr(new Date(now.getFullYear(), now.getMonth() - 3, 1));
  const rule = (note, type, cat, amount, day) => {
    const first = new Date(now.getFullYear(), now.getMonth() - 3, day);
    state.recurring.push({
      id: uid(), note, type, categoryId: id(cat), amount, frequency: 'monthly',
      startDate: toDateStr(first), nextDate: toDateStr(first), anchorDay: day, paused: false, endDate: '',
    });
  };
  rule('Salary', 'income', 'Salary', 4000, 1);
  rule('Rent', 'expense', 'Housing', 1200, 1);
  rule('Gym membership', 'expense', 'Health', 40, 5);
  rule('Internet', 'expense', 'Utilities', 55, 12);
  rule('Electricity', 'expense', 'Utilities', 90, 18);
  rule('Streaming', 'expense', 'Entertainment', 16, 20);

  // Deterministic pseudo-random spending so the sample looks the same each time.
  let seed = 42;
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const between = (lo, hi) => Math.round((lo + rand() * (hi - lo)) * 100) / 100;
  const daily = [
    ['Groceries', 0.28, 15, 70, ['Supermarket', 'Fresh market', 'Bakery']],
    ['Dining out', 0.16, 8, 40, ['Lunch', 'Coffee', 'Dinner with friends']],
    ['Transport', 0.22, 4, 25, ['Ride share', 'Fuel', 'Bus pass top-up']],
    ['Shopping', 0.06, 20, 90, ['Clothes', 'Home supplies', 'Online order']],
    ['Entertainment', 0.05, 10, 35, ['Cinema', 'Concert', 'Game']],
    ['Education', 0.03, 10, 40, ['Online course', 'Books']],
    ['Other', 0.03, 5, 30, ['Gift', 'Misc']],
  ];
  for (let d = start; d <= todayStr(); d = addDays(d, 1)) {
    for (const [cat, chance, lo, hi, notes] of daily) {
      if (rand() < chance) {
        state.transactions.push({
          id: uid(), created: Date.now(), type: 'expense', amount: between(lo, hi),
          categoryId: id(cat), date: d, note: notes[Math.floor(rand() * notes.length)],
        });
      }
    }
    if (parseDate(d).getDate() === 25 && rand() < 0.7) {
      state.transactions.push({ id: uid(), created: Date.now(), type: 'income', amount: between(150, 450), categoryId: id('Freelance'), date: d, note: 'Freelance project' });
    }
  }

  const inMonths = n => toDateStr(new Date(now.getFullYear(), now.getMonth() + n, 1));
  state.goals.push(
    { id: uid(), name: 'Emergency fund', target: 6000, saved: 1850, deadline: inMonths(12), color: COLORS[1] },
    { id: uid(), name: 'New laptop', target: 1400, saved: 420, deadline: inMonths(5), color: COLORS[4] },
    { id: uid(), name: 'Summer trip', target: 2000, saved: 300, deadline: '', color: COLORS[5] },
  );
  runSchedules();
  save();
}

/* ---------- Event handling ---------- */

const findIn = (list, id) => state[list].find(x => x.id === id);

const ACTIONS = {
  'add-tx': () => txForm(),
  'edit-tx': id => txForm(findIn('transactions', id)),
  'delete-tx': id => {
    if (!confirm('Delete this transaction?')) return;
    state.transactions = state.transactions.filter(t => t.id !== id);
    toast('Transaction deleted');
    return true;
  },
  'add-cat': (id, el) => categoryForm(null, el.dataset.kind),
  'edit-cat': id => categoryForm(findIn('categories', id)),
  'delete-cat': id => {
    const c = findIn('categories', id);
    const used = state.transactions.some(t => t.categoryId === id) || state.recurring.some(r => r.categoryId === id);
    const msg = used
      ? `Delete "${c.name}"? Transactions in it will show as Uncategorized.`
      : `Delete "${c.name}"?`;
    if (!confirm(msg)) return;
    state.categories = state.categories.filter(x => x.id !== id);
    return true;
  },
  'add-rule': () => ruleForm(),
  'set-balance': () => openModal('Correct your balance', `<p class="muted">Enter the balance your bank shows right now. The app keeps your transactions as they are and adjusts its starting balance so the two match.</p>
      <label>Balance today<input name="balance" type="number" step="any" inputmode="decimal" required value="${currentBalance()}"></label>`, d => {
    const actual = parseFloat(String(d.balance).replace(/,/g, ''));
    if (!Number.isFinite(actual)) return formError('Enter your balance.');
    state.settings.openingBalance = Math.round(((Number(state.settings.openingBalance) || 0) + actual - currentBalance()) * 100) / 100;
    toast('Balance updated');
  }),
  'edit-rule': id => ruleForm(findIn('recurring', id)),
  'toggle-rule': id => {
    const r = findIn('recurring', id);
    r.paused = !r.paused;
    // When resuming, skip the dates missed while paused instead of back-filling them.
    if (!r.paused) {
      const today = todayStr();
      let guard = 0;
      while (r.nextDate < today && guard++ < 1000) r.nextDate = nextOccurrence(r.nextDate, r.frequency, r.anchorDay);
      runSchedules();
    }
    toast(r.paused ? 'Paused' : 'Resumed');
    return true;
  },
  'delete-rule': id => {
    if (!confirm('Stop this schedule? Transactions already added are kept.')) return;
    state.recurring = state.recurring.filter(r => r.id !== id);
    return true;
  },
  'add-goal': () => goalForm(),
  'edit-goal': id => goalForm(findIn('goals', id)),
  'delete-goal': id => {
    if (!confirm('Delete this goal?')) return;
    state.goals = state.goals.filter(g => g.id !== id);
    return true;
  },
  'contribute': id => goalMoneyForm(findIn('goals', id), 1),
  'withdraw': id => goalMoneyForm(findIn('goals', id), -1),
  'export-csv': () => exportCsv(txInMonth(ui.month), `transactions-${ui.month}.csv`),
  'export-csv-all': () => exportCsv(state.transactions, 'transactions-all.csv'),
  'export-json': () => download(`budget-backup-${todayStr()}.json`, JSON.stringify(state, null, 2), 'application/json'),
  'import-json': () => document.getElementById('importFile').click(),
  'sms-test': () => openModal('Add from a bank message', `<label>Paste the text message
      <textarea name="sms" rows="5" placeholder="Purchase of AED 25.00 with Debit Card ending 1234 at …"></textarea></label>`, d => {
    const p = parseBankSms(d.sms);
    if (p.error) return formError(p.error);
    const tx = addSmsTransaction(p);
    if (!tx) return formError('This message was already added.');
    setTimeout(() => announceSmsTransaction(tx, p), 0);
  }, 'Add'),
  'copy-sms-link': () => {
    const link = `${location.origin}${location.pathname}#sms=`;
    if (navigator.clipboard) navigator.clipboard.writeText(link).then(() => toast('Link copied'), () => prompt('Copy this link:', link));
    else prompt('Copy this link:', link);
  },
  'forget-rules': () => {
    state.merchantRules = {};
    toast('Forgotten');
    return true;
  },
  'sample': () => {
    const hasData = state.transactions.length || state.recurring.length || state.goals.length;
    if (hasData && !confirm('Replace all current data with sample data?')) return;
    loadSampleData();
    ui.month = periodKeyFor(todayStr());
    toast('Sample data loaded');
    location.hash = '#dashboard';
    return true;
  },
  'reset': () => {
    if (!confirm('Delete ALL your data? This cannot be undone. Consider downloading a backup first.')) return;
    state = defaultState();
    toast('Everything deleted');
    return true;
  },
};

$view.addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const handler = ACTIONS[el.dataset.action];
  if (handler && handler(el.dataset.id, el) === true) {
    save();
    render();
  }
});

$view.addEventListener('change', e => {
  const el = e.target;
  if (el.dataset.budgetId) {
    const c = findIn('categories', el.dataset.budgetId);
    c.budget = Math.max(0, parseFloat(el.value) || 0);
  } else if (el.dataset.setting === 'monthStartDay') {
    state.settings.monthStartDay = Number(el.value) || 1;
    ui.month = periodKeyFor(todayStr());
    toast(startDay() === 1 ? 'Budget months follow the calendar' : `Budget months now run from day ${startDay()}`);
  } else if (el.dataset.setting === 'plannedIncome') {
    state.settings.plannedIncome = Math.max(0, parseFloat(el.value) || 0);
  } else if (el.dataset.setting === 'currency') {
    state.settings.currency = el.value;
    toast(`Currency set to ${el.value}`);
  } else if (el.id === 'forecastHorizon') {
    ui.forecast = el.value;
    render();
    return;
  } else if (el.id === 'filterType') {
    ui.filterType = el.value;
  } else if (el.id === 'filterCat') {
    ui.filterCat = el.value;
  } else {
    return;
  }
  save();
  render();
});

$view.addEventListener('input', e => {
  if (e.target.id === 'search') {
    ui.search = e.target.value;
    render();
  }
});

document.getElementById('addTxBtn').addEventListener('click', () => txForm());
document.getElementById('prevMonth').addEventListener('click', () => { ui.month = shiftMonth(ui.month, -1); render(); });
document.getElementById('nextMonth').addEventListener('click', () => { ui.month = shiftMonth(ui.month, 1); render(); });
document.getElementById('monthLabel').addEventListener('click', () => { ui.month = periodKeyFor(todayStr()); render(); });

function routeFromHash() {
  const v = location.hash.slice(1);
  ui.view = VIEWS.includes(v) ? v : 'dashboard';
  render();
}
window.addEventListener('hashchange', () => {
  const notify = handleIncomingSms() || handleIncomingImport() || handleIncomingUpdate();
  routeFromHash();
  if (notify) notify();
});

// Keep schedules up to date if the tab stays open past midnight.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && runSchedules()) render();
});

/* ---------- Start ---------- */

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(err => console.warn('Offline mode unavailable', err));
}

const added = runSchedules();
const smsNotify = handleIncomingSms() || handleIncomingImport() || handleIncomingUpdate();
routeFromHash();
if (smsNotify) smsNotify();
else if (added) toast(`${added} scheduled transaction${added === 1 ? '' : 's'} added`);
