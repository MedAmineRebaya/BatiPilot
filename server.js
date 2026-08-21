#!/usr/bin/env node
/* =========================================================
   BâtiPilot — Serveur JSON local
   ---------------------------------------------------------
   API REST compatible avec ERP.Api (mode http).
   Persistance : db.json (sauvegardé à chaque mutation).

   Démarrage :
     npm install
     npm start

   Puis dans Paramètres → Adresse de l'API :
     http://localhost:3001/api/v1
   et cliquer « Connecter l'API ».
   ========================================================= */
'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');

const PORT = process.env.PORT || 3001;
const ROOT = __dirname;
const DB_PATH = path.join(ROOT, 'db.json');
const SEED_PATH = path.join(ROOT, 'db.seed.json');

/* ---------- Date helpers (alignés sur data.js) ---------- */
const dt = {
  parse: (s) => {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d);
  },
  iso: (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
  add: (s, n) => {
    const d = dt.parse(s);
    d.setDate(d.getDate() + n);
    return dt.iso(d);
  },
  diff: (a, b) => Math.round((dt.parse(b) - dt.parse(a)) / 86400000),
  isWeekend: (s) => [0, 6].includes(dt.parse(s).getDay())
};

/* ---------- Charge / sauvegarde ---------- */
function loadDB() {
  if (!fs.existsSync(DB_PATH)) {
    if (fs.existsSync(SEED_PATH)) {
      fs.copyFileSync(SEED_PATH, DB_PATH);
      console.log('→ db.json créé depuis db.seed.json');
    } else {
      console.error('Aucun db.json ni db.seed.json trouvé. Lancez d\'abord le seed.');
      process.exit(1);
    }
  }
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
}

let DB = loadDB();
let saveTimer = null;

function saveDB(immediate = false) {
  const write = () => {
    try {
      fs.writeFileSync(DB_PATH, JSON.stringify(DB, null, 2));
    } catch (e) {
      console.error('Erreur sauvegarde db.json', e.message);
    }
  };
  if (immediate) {
    if (saveTimer) clearTimeout(saveTimer);
    write();
    return;
  }
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(write, 200);
}

/* ---------- Utilitaires métier ---------- */
const byId = (arr, id) => (arr || []).find((x) => x.id === id) || null;
const isLate = (t) => t.status !== 'termine' && t.due < DB.today;

function getTimesheets(date) {
  if (!DB.timesheetsByDate) DB.timesheetsByDate = {};
  if (!DB.timesheetsByDate[date]) DB.timesheetsByDate[date] = [];
  return DB.timesheetsByDate[date];
}

function decorateProject(p) {
  const client = byId(DB.clients, p.clientId);
  const team = (DB.workers || []).filter((w) => w.projectId === p.id);
  const ts = getTimesheets(DB.today).filter((t) => t.projectId === p.id);
  const present = ts.filter((t) => t.status !== 'absent');
  const pTasks = (DB.tasks || []).filter((t) => t.projectId === p.id);
  const late = (p.phases || []).filter((ph) => ph.progress < 100 && ph.end < DB.today);
  const daysLate = late.length ? Math.max(...late.map((ph) => dt.diff(ph.end, DB.today))) : 0;
  return Object.assign({}, p, {
    clientName: client ? client.company : '—',
    clientContact: client ? client.contact : '—',
    teamSize: team.length,
    presentToday: present.length,
    hoursToday: present.reduce((s, t) => s + t.hours, 0),
    remaining: p.budget - p.spent,
    burn: p.budget ? Math.round((p.spent / p.budget) * 100) : 0,
    tasksTotal: pTasks.length,
    tasksLate: pTasks.filter(isLate).length,
    tasksDone: pTasks.filter((t) => t.status === 'termine').length,
    daysLate,
    latePhases: late.map((ph) => ph.name),
    materialsCount: (DB.projectMaterials || []).filter((m) => m.projectId === p.id).length,
    materialsCost: (DB.projectMaterials || [])
      .filter((m) => m.projectId === p.id)
      .reduce((s, m) => {
        const a = byId(DB.articles, m.articleId);
        return s + (a ? m.qty * a.price : 0);
      }, 0)
  });
}

function decorateMaterial(m) {
  const a = byId(DB.articles, m.articleId);
  const p = byId(DB.projects, m.projectId);
  return Object.assign({}, m, {
    name: a ? a.name : '—',
    ref: a ? a.ref : '—',
    unit: a ? a.unit : '',
    category: a ? a.category : '—',
    price: a ? a.price : 0,
    total: a ? m.qty * a.price : 0,
    stock: a ? a.stock : 0,
    min: a ? a.min : 0,
    stockStatus: a ? a.stockStatus : 'ok',
    supplier: a ? a.supplier : '—',
    projectName: p ? p.name : '—'
  });
}

function decorateSupplier(s) {
  const arts = (DB.articles || []).filter((a) => a.supplierId === s.id);
  const moves = (DB.projectMaterials || []).filter((m) => {
    const a = byId(DB.articles, m.articleId);
    return a && a.supplierId === s.id;
  });
  const purchases = moves.reduce((sum, m) => {
    const a = byId(DB.articles, m.articleId);
    return sum + (a ? m.qty * a.price : 0);
  }, 0);
  const lastMove = moves.length
    ? moves.slice().sort((x, y) => y.date.localeCompare(x.date))[0].date
    : null;
  return Object.assign({}, s, {
    articleCount: arts.length,
    featuredCount: (s.featured || []).length,
    alerts: arts.filter((a) => a.stockStatus !== 'ok').length,
    ruptures: arts.filter((a) => a.stockStatus === 'rupture').length,
    stockValue: arts.reduce((sum, a) => sum + a.stock * a.price, 0),
    purchases,
    lastMove,
    projectCount: new Set(moves.map((m) => m.projectId)).size
  });
}

function decorateClient(c) {
  const ps = (DB.projects || []).filter((p) => p.clientId === c.id);
  return Object.assign({}, c, {
    projectCount: ps.length,
    totalAmount: ps.reduce((s, p) => s + p.budget, 0),
    openCount: ps.filter((p) => p.status !== 'termine').length,
    lastProject: ps.length ? ps.slice().sort((a, b) => b.start.localeCompare(a.start))[0].name : '—'
  });
}

function decorateWorker(w) {
  const p = byId(DB.projects, w.projectId);
  const entry = getTimesheets(DB.today).find((t) => t.workerId === w.id) || null;
  let month = 0;
  for (let i = 0; i < 30; i++) {
    const d = dt.add(DB.today, -i);
    if (dt.isWeekend(d)) continue;
    const e = getTimesheets(d).find((t) => t.workerId === w.id);
    if (e) month += e.hours;
  }
  return Object.assign({}, w, {
    projectName: p ? p.name : 'Non affecté',
    todayStatus: entry ? entry.status : 'non_planifie',
    todayEntry: entry,
    monthHours: Math.round(month),
    monthCost: Math.round(month * w.rate)
  });
}

function moveStock(article, delta) {
  article.stock = Math.max(0, article.stock + delta);
  article.stockStatus =
    article.stock === 0 ? 'rupture' : article.stock < article.min ? 'faible' : 'ok';
  if (delta > 0) article.lastEntry = DB.today;
}

function chargeProject(projectId, amount) {
  const p = byId(DB.projects, projectId);
  if (!p) return;
  p.spent = Math.max(0, Math.round(p.spent + amount));
  const key = `DEP-${projectId}-materiaux`;
  const line = (DB.expenses || []).find((e) => e.id === key);
  if (line) line.amount = Math.max(0, Math.round(line.amount + amount));
  else {
    if (!DB.expenses) DB.expenses = [];
    DB.expenses.push({
      id: key,
      projectId,
      category: 'materiaux',
      label: 'Matériaux',
      amount: Math.max(0, Math.round(amount))
    });
  }
}

function nextId(prefix, arr, pad = 3) {
  const nums = (arr || [])
    .map((x) => {
      const m = String(x.id || '').match(/(\d+)$/);
      return m ? parseInt(m[1], 10) : 0;
    })
    .filter((n) => !isNaN(n));
  const n = (nums.length ? Math.max(...nums) : 0) + 1;
  return prefix + String(n).padStart(pad, '0');
}

/* ---------- Express ---------- */
const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

// Log de chaque requête
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    const ts = new Date().toLocaleTimeString('fr-FR');
    console.log(`[${ts}] ${req.method} ${req.originalUrl} → ${res.statusCode} (${ms}ms)`);
  });
  next();
});

const api = express.Router();

/* ---- Dashboard ---- */
api.get('/dashboard/kpis', (req, res) => {
  const active = DB.projects.filter((x) => x.status !== 'termine');
  const done = DB.projects.filter((x) => x.status === 'termine');
  const ts = getTimesheets(DB.today);
  const present = ts.filter((t) => t.status !== 'absent');
  const budget = active.reduce((s, x) => s + x.budget, 0);
  const spent = active.reduce((s, x) => s + x.spent, 0);
  res.json({
    activeProjects: active.length,
    doneProjects: done.length,
    scheduled: ts.length,
    present: present.length,
    absent: ts.length - present.length,
    hoursToday: present.reduce((s, t) => s + t.hours, 0),
    lateTasks: DB.tasks.filter(isLate).length,
    lateProjects: active.filter((x) => x.status === 'en_retard').length,
    budget,
    spent,
    remaining: budget - spent,
    burn: budget ? Math.round((spent / budget) * 100) : 0
  });
});

api.get('/dashboard/activity', (req, res) => res.json(DB.activity || []));

/* ---- Projects ---- */
api.get('/projects', (req, res) => {
  let list = DB.projects.map(decorateProject);
  if (req.query.status && req.query.status !== 'tous') {
    list = list.filter((x) => x.status === req.query.status);
  }
  if (req.query.q) {
    const q = String(req.query.q).toLowerCase();
    list = list.filter((x) =>
      (x.name + x.clientName + x.city + x.address + x.ref).toLowerCase().includes(q)
    );
  }
  res.json(list);
});

api.get('/projects/:id', (req, res) => {
  const found = byId(DB.projects, req.params.id);
  if (!found) return res.status(404).json({ error: 'not_found' });
  res.json(decorateProject(found));
});

api.post('/projects', (req, res) => {
  const p = req.body || {};
  const picked = p.tasks || [];
  const item = Object.assign(
    {
      id: nextId('PRJ-', DB.projects),
      ref: 'CHT-' + DB.today.slice(0, 4) + '-' + String(DB.projects.length + 1).padStart(3, '0'),
      spent: 0,
      progress: 0,
      status: 'en_preparation'
    },
    p
  );
  delete item.tasks;
  item.phases = picked.map((t, i) => {
    const taskId = nextId('TSK-', DB.tasks);
    DB.tasks.push({
      id: taskId,
      title: t.name,
      projectId: item.id,
      assignee: t.assignee || item.manager,
      priority: t.priority || 'moyenne',
      start: t.start,
      due: t.end,
      progress: 0,
      status: 'a_faire',
      createdAt: DB.today
    });
    return {
      taskId,
      name: t.name,
      start: t.start,
      end: t.end,
      progress: 0,
      lead: t.assignee || item.manager
    };
  });
  DB.projects.unshift(item);
  saveDB();
  res.status(201).json(decorateProject(item));
});

api.patch('/projects/:id', (req, res) => {
  const p = byId(DB.projects, req.params.id);
  if (!p) return res.status(404).json({ error: 'not_found' });
  Object.assign(p, req.body || {});
  saveDB();
  res.json(decorateProject(p));
});

api.delete('/projects/:id', (req, res) => {
  const id = req.params.id;
  const i = DB.projects.findIndex((x) => x.id === id);
  if (i > -1) DB.projects.splice(i, 1);
  // Nettoyer tâches et matériaux liés
  DB.tasks = (DB.tasks || []).filter((t) => t.projectId !== id);
  DB.projectMaterials = (DB.projectMaterials || []).filter((m) => m.projectId !== id);
  saveDB();
  res.status(204).end();
});

/* ---- Clients ---- */
api.get('/clients', (req, res) => {
  let list = DB.clients.map(decorateClient);
  if (req.query.status && req.query.status !== 'tous') {
    list = list.filter((x) => x.status === req.query.status);
  }
  if (req.query.q) {
    const q = String(req.query.q).toLowerCase();
    list = list.filter((x) =>
      (x.company + x.contact + x.city + x.email).toLowerCase().includes(q)
    );
  }
  res.json(list);
});

api.get('/clients/:id', (req, res) => {
  const c = byId(DB.clients, req.params.id);
  if (!c) return res.status(404).json({ error: 'not_found' });
  const history = []; // simplified — full history was generated client-side
  res.json(
    Object.assign(decorateClient(c), {
      projects: DB.projects.filter((x) => x.clientId === c.id).map(decorateProject),
      quotes: (DB.quotes || []).filter((q) => q.clientId === c.id),
      history
    })
  );
});

api.post('/clients', (req, res) => {
  const body = req.body || {};
  const item = Object.assign({
    id: nextId('CLI-', DB.clients),
    company: '', contact: '', city: 'Tunis', phone: '', email: '', address: '',
    status: 'actif', since: DB.today
  }, body);
  DB.clients.unshift(item);
  saveDB();
  res.status(201).json(decorateClient(item));
});

api.patch('/clients/:id', (req, res) => {
  const c = byId(DB.clients, req.params.id);
  if (!c) return res.status(404).json({ error: 'not_found' });
  Object.assign(c, req.body || {});
  saveDB();
  res.json(decorateClient(c));
});

api.delete('/clients/:id', (req, res) => {
  const i = DB.clients.findIndex((x) => x.id === req.params.id);
  if (i > -1) DB.clients.splice(i, 1);
  saveDB();
  res.status(204).end();
});

/* ---- Workers ---- */
api.get('/workers', (req, res) => {
  let list = DB.workers.map(decorateWorker);
  if (req.query.projectId && req.query.projectId !== 'tous') {
    list = list.filter((x) => x.projectId === req.query.projectId);
  }
  if (req.query.trade && req.query.trade !== 'tous') {
    list = list.filter((x) => x.trade === req.query.trade);
  }
  if (req.query.q) {
    const q = String(req.query.q).toLowerCase();
    list = list.filter((x) => (x.name + x.trade + (x.matricule || '')).toLowerCase().includes(q));
  }
  res.json(list);
});

api.get('/workers/:id', (req, res) => {
  const w = byId(DB.workers, req.params.id);
  if (!w) return res.status(404).json({ error: 'not_found' });
  res.json(decorateWorker(w));
});

api.post('/workers', (req, res) => {
  const body = req.body || {};
  const item = Object.assign({
    id: nextId('OUV-', DB.workers),
    name: '', trade: 'Maçon', projectId: null, rate: 15,
    phone: '', status: 'actif'
  }, body);
  DB.workers.unshift(item);
  saveDB();
  res.status(201).json(decorateWorker(item));
});

api.patch('/workers/:id', (req, res) => {
  const w = byId(DB.workers, req.params.id);
  if (!w) return res.status(404).json({ error: 'not_found' });
  Object.assign(w, req.body || {});
  saveDB();
  res.json(decorateWorker(w));
});

api.delete('/workers/:id', (req, res) => {
  const i = DB.workers.findIndex((x) => x.id === req.params.id);
  if (i > -1) DB.workers.splice(i, 1);
  saveDB();
  res.status(204).end();
});

/* ---- Timesheets ---- */
api.get('/timesheets', (req, res) => {
  const date = req.query.date || DB.today;
  let rows = getTimesheets(date).map((r) =>
    Object.assign({}, r, {
      projectName: (byId(DB.projects, r.projectId) || {}).name || '—'
    })
  );
  if (req.query.projectId && req.query.projectId !== 'tous') {
    rows = rows.filter((r) => r.projectId === req.query.projectId);
  }
  if (req.query.trade && req.query.trade !== 'tous') {
    rows = rows.filter((r) => r.trade === req.query.trade);
  }
  if (req.query.status && req.query.status !== 'tous') {
    rows = rows.filter((r) => r.status === req.query.status);
  }
  if (req.query.q) {
    rows = rows.filter((r) => r.worker.toLowerCase().includes(String(req.query.q).toLowerCase()));
  }
  res.json(rows);
});

api.get('/timesheets/summary', (req, res) => {
  const date = req.query.date || DB.today;
  const rows = getTimesheets(date);
  const present = rows.filter((r) => r.status !== 'absent');
  res.json({
    date,
    scheduled: rows.length,
    present: present.length,
    absent: rows.filter((r) => r.status === 'absent').length,
    late: rows.filter((r) => r.status === 'retard').length,
    hours: present.reduce((s, r) => s + r.hours, 0),
    cost: Math.round(
      present.reduce((s, r) => {
        const w = byId(DB.workers, r.workerId);
        return s + r.hours * (w ? w.rate : 15);
      }, 0)
    )
  });
});

api.post('/timesheets', (req, res) => {
  const entry = req.body || {};
  const rows = getTimesheets(entry.date || DB.today);
  const worker = byId(DB.workers, entry.workerId);
  const hours = Math.max(0, (entry.out - entry.in - entry.breakMin) / 60);
  const existing = rows.find((r) => r.workerId === entry.workerId);
  const row = {
    id: 'PTG-' + (entry.date || DB.today) + '-' + entry.workerId,
    date: entry.date || DB.today,
    workerId: entry.workerId,
    worker: worker ? worker.name : '—',
    trade: worker ? worker.trade : '—',
    projectId: entry.projectId,
    in: entry.in,
    out: entry.out,
    breakMin: entry.breakMin,
    hours,
    status: entry.status || (entry.in > 435 ? 'retard' : 'present'),
    note: entry.note || ''
  };
  if (existing) Object.assign(existing, row);
  else rows.push(row);
  saveDB();
  res.status(201).json(row);
});

api.patch('/timesheets/:id', (req, res) => {
  const id = req.params.id;
  const patch = req.body || {};
  let found = null;
  for (const date of Object.keys(DB.timesheetsByDate || {})) {
    const rows = DB.timesheetsByDate[date];
    const row = rows.find((r) => r.id === id);
    if (row) {
      Object.assign(row, patch);
      if (patch.in != null || patch.out != null || patch.breakMin != null) {
        row.hours = Math.max(0, (row.out - row.in - (row.breakMin || 0)) / 60);
      }
      found = row;
      break;
    }
  }
  if (!found) return res.status(404).json({ error: 'not_found' });
  saveDB();
  res.json(found);
});

api.delete('/timesheets/:id', (req, res) => {
  const id = req.params.id;
  let removed = false;
  for (const date of Object.keys(DB.timesheetsByDate || {})) {
    const rows = DB.timesheetsByDate[date];
    const i = rows.findIndex((r) => r.id === id);
    if (i > -1) { rows.splice(i, 1); removed = true; break; }
  }
  if (!removed) return res.status(404).json({ error: 'not_found' });
  saveDB();
  res.status(204).end();
});

/* ---- Articles ---- */
api.get('/articles', (req, res) => {
  let list = [...(DB.articles || [])];
  if (req.query.category && req.query.category !== 'tous') {
    list = list.filter((a) => a.category === req.query.category);
  }
  if (req.query.stockStatus && req.query.stockStatus !== 'tous') {
    list = list.filter((a) => a.stockStatus === req.query.stockStatus);
  }
  if (req.query.q) {
    const q = String(req.query.q).toLowerCase();
    list = list.filter((a) =>
      (a.name + a.ref + a.supplier + a.category).toLowerCase().includes(q)
    );
  }
  res.json(list);
});

api.get('/articles/:id', (req, res) => {
  const a = byId(DB.articles, req.params.id);
  if (!a) return res.status(404).json({ error: 'not_found' });
  res.json(a);
});

api.post('/articles', (req, res) => {
  const a = req.body || {};
  const item = Object.assign(
    {
      id: nextId('ART-', DB.articles),
      ref: 'MAT-' + String(DB.articles.length + 1).padStart(4, '0'),
      location: 'Dépôt central Tunis',
      lastEntry: DB.today
    },
    a
  );
  item.stockStatus = item.stock === 0 ? 'rupture' : item.stock < item.min ? 'faible' : 'ok';
  DB.articles.unshift(item);
  saveDB();
  res.status(201).json(item);
});

api.patch('/articles/:id', (req, res) => {
  const a = byId(DB.articles, req.params.id);
  if (!a) return res.status(404).json({ error: 'not_found' });
  Object.assign(a, req.body || {});
  a.stockStatus = a.stock === 0 ? 'rupture' : a.stock < a.min ? 'faible' : 'ok';
  saveDB();
  res.json(a);
});

api.delete('/articles/:id', (req, res) => {
  const i = DB.articles.findIndex((x) => x.id === req.params.id);
  if (i > -1) DB.articles.splice(i, 1);
  saveDB();
  res.status(204).end();
});

/* ---- Tasks ---- */
api.get('/tasks', (req, res) => {
  let list = DB.tasks.map((t) =>
    Object.assign({}, t, {
      projectName: (byId(DB.projects, t.projectId) || {}).name || '—',
      late: isLate(t)
    })
  );
  if (req.query.projectId && req.query.projectId !== 'tous') {
    list = list.filter((t) => t.projectId === req.query.projectId);
  }
  if (req.query.status && req.query.status !== 'tous') {
    list = list.filter((t) => t.status === req.query.status);
  }
  if (req.query.priority && req.query.priority !== 'tous') {
    list = list.filter((t) => t.priority === req.query.priority);
  }
  if (req.query.q) {
    list = list.filter((t) =>
      (t.title + t.assignee).toLowerCase().includes(String(req.query.q).toLowerCase())
    );
  }
  res.json(list);
});

api.post('/tasks', (req, res) => {
  const t = req.body || {};
  const item = Object.assign(
    {
      id: nextId('TSK-', DB.tasks),
      progress: 0,
      status: 'a_faire',
      createdAt: DB.today
    },
    t
  );
  DB.tasks.unshift(item);
  saveDB();
  res.status(201).json(item);
});

api.patch('/tasks/:id', (req, res) => {
  const t = byId(DB.tasks, req.params.id);
  if (!t) return res.status(404).json({ error: 'not_found' });
  Object.assign(t, req.body || {});
  const p = byId(DB.projects, t.projectId);
  const phase = p && (p.phases || []).find((ph) => ph.taskId === t.id);
  if (phase) {
    phase.name = t.title;
    phase.start = t.start;
    phase.end = t.due;
    phase.progress = t.progress;
    phase.lead = t.assignee;
  }
  saveDB();
  res.json(t);
});

api.delete('/tasks/:id', (req, res) => {
  const t = byId(DB.tasks, req.params.id);
  if (t) {
    const p = byId(DB.projects, t.projectId);
    if (p && p.phases) {
      const i = p.phases.findIndex((ph) => ph.taskId === t.id);
      if (i > -1) p.phases.splice(i, 1);
    }
  }
  const i = DB.tasks.findIndex((x) => x.id === req.params.id);
  if (i > -1) DB.tasks.splice(i, 1);
  saveDB();
  res.status(204).end();
});

/* ---- Materials (project allocations) ---- */
api.get('/materials', (req, res) => {
  let list = [...(DB.projectMaterials || [])];
  if (req.query.projectId && req.query.projectId !== 'tous') {
    list = list.filter((m) => m.projectId === req.query.projectId);
  }
  if (req.query.articleId) list = list.filter((m) => m.articleId === req.query.articleId);
  res.json(
    list
      .map(decorateMaterial)
      .sort((a, b) => b.date.localeCompare(a.date))
  );
});

api.post('/materials', (req, res) => {
  const m = req.body || {};
  const a = byId(DB.articles, m.articleId);
  if (!a) return res.status(400).json({ error: 'Article introuvable' });
  if (m.qty > a.stock) return res.status(400).json({ error: 'stock_insuffisant' });
  const item = Object.assign(
    {
      id: 'AFF-' + Date.now().toString(36).toUpperCase(),
      date: DB.today,
      author: DB.user.name,
      note: ''
    },
    m
  );
  DB.projectMaterials.push(item);
  moveStock(a, -item.qty);
  chargeProject(item.projectId, item.qty * a.price);
  saveDB();
  res.status(201).json(decorateMaterial(item));
});

api.patch('/materials/:id', (req, res) => {
  const item = (DB.projectMaterials || []).find((x) => x.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'not_found' });
  const a = byId(DB.articles, item.articleId);
  const patch = req.body || {};
  if (patch.qty != null && a) {
    const delta = patch.qty - item.qty;
    if (delta > a.stock) return res.status(400).json({ error: 'stock_insuffisant' });
    moveStock(a, -delta);
    chargeProject(item.projectId, delta * a.price);
  }
  Object.assign(item, patch);
  saveDB();
  res.json(decorateMaterial(item));
});

api.delete('/materials/:id', (req, res) => {
  const i = (DB.projectMaterials || []).findIndex((x) => x.id === req.params.id);
  if (i > -1) {
    const item = DB.projectMaterials[i];
    const a = byId(DB.articles, item.articleId);
    if (a) {
      moveStock(a, item.qty);
      chargeProject(item.projectId, -item.qty * a.price);
    }
    DB.projectMaterials.splice(i, 1);
  }
  saveDB();
  res.status(204).end();
});

/* ---- Suppliers ---- */
api.get('/suppliers', (req, res) => {
  let list = DB.suppliers.map(decorateSupplier);
  if (req.query.status && req.query.status !== 'tous') {
    list = list.filter((s) => s.status === req.query.status);
  }
  if (req.query.city && req.query.city !== 'tous') {
    list = list.filter((s) => s.city === req.query.city);
  }
  if (req.query.q) {
    const q = String(req.query.q).toLowerCase();
    list = list.filter((s) =>
      (s.company + s.contact + s.city + s.specialty).toLowerCase().includes(q)
    );
  }
  res.json(list);
});

api.get('/suppliers/:id', (req, res) => {
  const s = byId(DB.suppliers, req.params.id);
  if (!s) return res.status(404).json({ error: 'not_found' });
  res.json(
    Object.assign(decorateSupplier(s), {
      articles: DB.articles
        .filter((a) => a.supplierId === s.id)
        .map((a) => Object.assign({}, a, { isFeatured: (s.featured || []).includes(a.id) }))
        .sort((a, b) => b.isFeatured - a.isFeatured || a.name.localeCompare(b.name)),
      deliveries: (DB.projectMaterials || [])
        .filter((m) => {
          const a = byId(DB.articles, m.articleId);
          return a && a.supplierId === s.id;
        })
        .map((m) => {
          const a = byId(DB.articles, m.articleId);
          const p = byId(DB.projects, m.projectId);
          return {
            id: m.id,
            date: m.date,
            qty: m.qty,
            unit: a.unit,
            article: a.name,
            amount: m.qty * a.price,
            projectName: p ? p.name : '—',
            projectId: m.projectId
          };
        })
        .sort((x, y) => y.date.localeCompare(x.date))
    })
  );
});

api.post('/suppliers', (req, res) => {
  const s = req.body || {};
  const item = Object.assign(
    {
      id: nextId('FRN-', DB.suppliers),
      since: DB.today,
      status: 'actif',
      featured: [],
      rating: 4,
      leadDays: 3,
      taxId: '',
      payment: '30 jours fin de mois',
      note: ''
    },
    s
  );
  DB.suppliers.unshift(item);
  saveDB();
  res.status(201).json(item);
});

api.patch('/suppliers/:id', (req, res) => {
  const s = byId(DB.suppliers, req.params.id);
  if (!s) return res.status(404).json({ error: 'not_found' });
  const oldName = s.company;
  const patch = req.body || {};
  Object.assign(s, patch);
  if (patch.company && patch.company !== oldName) {
    DB.articles
      .filter((a) => a.supplierId === s.id)
      .forEach((a) => {
        a.supplier = patch.company;
      });
  }
  saveDB();
  res.json(s);
});

api.delete('/suppliers/:id', (req, res) => {
  const i = DB.suppliers.findIndex((x) => x.id === req.params.id);
  if (i > -1) DB.suppliers.splice(i, 1);
  saveDB();
  res.status(204).end();
});

api.post('/suppliers/:id/featured/:articleId', (req, res) => {
  const s = byId(DB.suppliers, req.params.id);
  if (!s) return res.status(404).json({ error: 'not_found' });
  if (!s.featured) s.featured = [];
  const i = s.featured.indexOf(req.params.articleId);
  if (i > -1) s.featured.splice(i, 1);
  else s.featured.push(req.params.articleId);
  saveDB();
  res.json({ featured: i === -1, count: s.featured.length });
});

/* ---- Task catalog ---- */
api.get('/task-catalog', (req, res) => res.json(DB.taskCatalog || []));

api.post('/task-catalog', (req, res) => {
  const c = req.body || {};
  const item = Object.assign(
    {
      id: nextId('CAT-', DB.taskCatalog),
      active: true,
      defaultDays: 10
    },
    c
  );
  DB.taskCatalog.push(item);
  saveDB();
  res.status(201).json(item);
});

api.patch('/task-catalog/:id', (req, res) => {
  const c = byId(DB.taskCatalog, req.params.id);
  if (!c) return res.status(404).json({ error: 'not_found' });
  Object.assign(c, req.body || {});
  saveDB();
  res.json(c);
});

api.delete('/task-catalog/:id', (req, res) => {
  const i = DB.taskCatalog.findIndex((x) => x.id === req.params.id);
  if (i > -1) DB.taskCatalog.splice(i, 1);
  saveDB();
  res.status(204).end();
});

/* ---- Attachments ---- */
api.get('/attachments/:projectId', (req, res) => {
  const list = (DB.attachments && DB.attachments[req.params.projectId]) || [];
  res.json(list.slice().sort((a, b) => b.date.localeCompare(a.date)));
});

api.post('/attachments/:projectId', (req, res) => {
  if (!DB.attachments) DB.attachments = {};
  const list = DB.attachments[req.params.projectId] || (DB.attachments[req.params.projectId] = []);
  const item = Object.assign(
    {
      id: 'ATT-' + Date.now().toString(36).toUpperCase(),
      date: DB.today,
      author: DB.user.name,
      kind: 'document'
    },
    req.body || {}
  );
  list.push(item);
  saveDB();
  res.status(201).json(item);
});

api.delete('/attachments/:projectId/:id', (req, res) => {
  const list = (DB.attachments && DB.attachments[req.params.projectId]) || [];
  const i = list.findIndex((x) => x.id === req.params.id);
  if (i > -1) list.splice(i, 1);
  saveDB();
  res.status(204).end();
});

/* ---- Quotes ---- */
api.get('/quotes', (req, res) => {
  let list = DB.quotes || [];
  if (req.query.clientId) list = list.filter((q) => q.clientId === req.query.clientId);
  res.json(list);
});

api.get('/quotes/:id', (req, res) => {
  const q = byId(DB.quotes, req.params.id);
  if (!q) return res.status(404).json({ error: 'not_found' });
  res.json(q);
});

api.post('/quotes', (req, res) => {
  const q = req.body || {};
  const year = DB.today.slice(0, 4);
  const item = Object.assign(
    {
      id: 'DEV-' + year + '-' + String((DB.quotes || []).length + 1).padStart(3, '0'),
      date: DB.today,
      status: 'en_attente',
      projectId: null
    },
    q
  );
  item.total = (item.lines || []).reduce((s, l) => s + l.qty * l.price, 0);
  if (!DB.quotes) DB.quotes = [];
  DB.quotes.unshift(item);
  saveDB();
  res.status(201).json(item);
});

api.patch('/quotes/:id', (req, res) => {
  const q = byId(DB.quotes, req.params.id);
  if (!q) return res.status(404).json({ error: 'not_found' });
  Object.assign(q, req.body || {});
  saveDB();
  res.json(q);
});

api.delete('/quotes/:id', (req, res) => {
  const i = (DB.quotes || []).findIndex((x) => x.id === req.params.id);
  if (i > -1) DB.quotes.splice(i, 1);
  saveDB();
  res.status(204).end();
});

/* ---- Budget ---- */
api.get('/budget/summary', (req, res) => {
  const active = DB.projects.filter((x) => x.status !== 'termine');
  const budget = active.reduce((s, x) => s + x.budget, 0);
  const spent = active.reduce((s, x) => s + x.spent, 0);
  res.json({
    budget,
    spent,
    remaining: budget - spent,
    burn: budget ? Math.round((spent / budget) * 100) : 0
  });
});

api.get('/budget/categories', (req, res) => {
  const projectId = req.query.projectId;
  res.json(
    (DB.costCategories || [])
      .map((c) => ({
        key: c.key,
        label: c.label,
        color: c.color,
        amount: (DB.expenses || [])
          .filter(
            (e) =>
              e.category === c.key &&
              (!projectId || projectId === 'tous' || e.projectId === projectId)
          )
          .reduce((s, e) => s + e.amount, 0)
      }))
      .sort((a, b) => b.amount - a.amount)
  );
});

api.get('/budget/projects', (req, res) => {
  res.json(DB.projects.filter((x) => x.status !== 'termine').map(decorateProject));
});

/* ---- Planning ---- */
api.get('/planning', (req, res) => {
  const list = DB.projects.filter((x) => x.status !== 'termine');
  if (req.query.projectId && req.query.projectId !== 'tous') {
    const pr = byId(DB.projects, req.query.projectId);
    if (!pr) return res.json([]);
    return res.json(
      (pr.phases || []).map((ph, i) => ({
        id: pr.id + '-P' + i,
        label: ph.name,
        sub: ph.lead,
        start: ph.start,
        end: ph.end,
        progress: ph.progress,
        status:
          ph.progress === 100
            ? 'termine'
            : ph.end < DB.today
              ? 'en_retard'
              : ph.progress > 0
                ? 'en_cours'
                : 'en_preparation',
        projectId: pr.id
      }))
    );
  }
  res.json(
    list.map((pr) => ({
      id: pr.id,
      label: pr.name,
      sub: (byId(DB.clients, pr.clientId) || {}).company || '',
      start: pr.start,
      end: pr.end,
      progress: pr.progress,
      status: pr.status,
      projectId: pr.id
    }))
  );
});

/* ---- Reports ---- */
api.get('/reports/attendance', (req, res) => {
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = dt.add(DB.today, -i);
    if (dt.isWeekend(d)) continue;
    const rows = getTimesheets(d);
    const present = rows.filter((r) => r.status !== 'absent');
    days.push({
      date: d,
      present: present.length,
      absent: rows.length - present.length,
      hours: Math.round(present.reduce((s, r) => s + r.hours, 0)),
      planned: rows.length * 8
    });
  }
  res.json(days);
});

api.get('/reports/trades', (req, res) => {
  const rows = getTimesheets(DB.today).filter((r) => r.status !== 'absent');
  const map = {};
  rows.forEach((r) => {
    map[r.trade] = (map[r.trade] || 0) + r.hours;
  });
  res.json(
    Object.entries(map)
      .map(([label, value]) => ({ label, value: Math.round(value) }))
      .sort((a, b) => b.value - a.value)
  );
});

/* ---- Notifications ---- */
api.get('/notifications', (req, res) => res.json(DB.notifications || []));

api.patch('/notifications/:id/read', (req, res) => {
  const n = byId(DB.notifications, req.params.id);
  if (n) n.read = true;
  saveDB();
  res.json(n);
});

api.post('/notifications/read-all', (req, res) => {
  (DB.notifications || []).forEach((n) => {
    n.read = true;
  });
  saveDB();
  res.json({ ok: true });
});

/* ---- Search ---- */
api.get('/search', (req, res) => {
  const q = String(req.query.q || '')
    .toLowerCase()
    .trim();
  if (q.length < 2) return res.json([]);
  const out = [];
  DB.projects
    .filter((x) => (x.name + x.ref).toLowerCase().includes(q))
    .slice(0, 4)
    .forEach((x) =>
      out.push({
        group: 'Projets',
        label: x.name,
        sub: x.ref + ' · ' + x.city,
        href: '#/projets/' + x.id,
        icon: 'building'
      })
    );
  DB.clients
    .filter((x) => (x.company + x.contact).toLowerCase().includes(q))
    .slice(0, 4)
    .forEach((x) =>
      out.push({
        group: 'Clients',
        label: x.company,
        sub: x.contact,
        href: '#/clients/' + x.id,
        icon: 'users'
      })
    );
  DB.workers
    .filter((x) => x.name.toLowerCase().includes(q))
    .slice(0, 4)
    .forEach((x) =>
      out.push({
        group: 'Ouvriers',
        label: x.name,
        sub: x.trade,
        href: '#/pointage/' + x.id,
        icon: 'hardhat'
      })
    );
  DB.articles
    .filter((x) => (x.name + x.ref).toLowerCase().includes(q))
    .slice(0, 4)
    .forEach((x) =>
      out.push({
        group: 'Articles',
        label: x.name,
        sub: x.ref + ' · ' + x.category,
        href: '#/articles/' + x.id,
        icon: 'package'
      })
    );
  DB.suppliers
    .filter((x) => (x.company + x.contact + x.specialty + x.city).toLowerCase().includes(q))
    .slice(0, 4)
    .forEach((x) =>
      out.push({
        group: 'Fournisseurs',
        label: x.company,
        sub: x.specialty + ' · ' + x.city,
        href: '#/fournisseurs/' + x.id,
        icon: 'truck'
      })
    );
  DB.tasks
    .filter((x) => x.title.toLowerCase().includes(q))
    .slice(0, 3)
    .forEach((x) =>
      out.push({
        group: 'Tâches',
        label: x.title,
        sub: x.assignee,
        href: '#/taches',
        icon: 'check'
      })
    );
  res.json(out);
});

/* ---- Meta / reset ---- */
api.get('/meta', (req, res) => {
  res.json({
    today: DB.today,
    mode: 'json-server',
    counts: {
      projects: DB.projects.length,
      clients: DB.clients.length,
      workers: DB.workers.length,
      articles: DB.articles.length,
      tasks: DB.tasks.length,
      suppliers: DB.suppliers.length
    }
  });
});

api.post('/reset', (req, res) => {
  if (!fs.existsSync(SEED_PATH)) {
    return res.status(400).json({ error: 'Aucun fichier seed (db.seed.json)' });
  }
  fs.copyFileSync(SEED_PATH, DB_PATH);
  DB = loadDB();
  res.json({ ok: true, message: 'Base réinitialisée depuis le seed' });
});

/* Racine de l'API — évite le « Cannot GET /api/v1 » dans le navigateur */
api.get('/', (req, res) => {
  res.json({
    name: 'BâtiPilot API',
    version: 'v1',
    today: DB.today,
    app: 'http://localhost:' + (process.env.PORT || 3001) + '/',
    endpoints: [
      'GET  /meta',
      'GET  /dashboard/kpis',
      'GET  /projects',
      'GET  /clients',
      'GET  /workers',
      'GET  /tasks',
      'GET  /articles',
      'GET  /suppliers',
      'GET  /timesheets',
      'GET  /budget/summary',
      'GET  /planning',
      'GET  /notifications',
      'GET  /search?q=',
      'POST /reset'
    ],
    counts: {
      projects: (DB.projects || []).length,
      clients: (DB.clients || []).length,
      workers: (DB.workers || []).length,
      articles: (DB.articles || []).length,
      tasks: (DB.tasks || []).length,
      suppliers: (DB.suppliers || []).length
    }
  });
});

app.use('/api/v1', api);

/* Fichiers statiques (HTML de l'app) */
app.use(express.static(ROOT));
app.get('/', (req, res) => {
  res.sendFile(path.join(ROOT, 'batipilot-standalone.html'));
});

app.listen(PORT, () => {
  console.log('');
  console.log('  BâtiPilot — serveur JSON');
  console.log('  ────────────────────────');
  console.log(`  App  : http://localhost:${PORT}/`);
  console.log(`  API  : http://localhost:${PORT}/api/v1`);
  console.log(`  DB   : ${DB_PATH}`);
  console.log('');
  console.log('  Dans Paramètres → Adresse API :');
  console.log(`    http://localhost:${PORT}/api/v1`);
  console.log('  puis « Connecter l\'API ».');
  console.log('');
});

process.on('SIGINT', () => {
  saveDB(true);
  process.exit(0);
});
process.on('SIGTERM', () => {
  saveDB(true);
  process.exit(0);
});
