#!/usr/bin/env node
/* =========================================================
   BâtiPilot — API Vercel (Express sur Supabase)
   ---------------------------------------------------------
   Même surface de routes que l'ancien server.js/db.json,
   mais chaque requête interroge Postgres via Supabase :
     - un client "utilisateur" (JWT transmis par le front,
       clé anon) pour toutes les opérations métier normales
       → la Row Level Security de Postgres fait le tri
       admin / ingénieur automatiquement ;
     - un client "service role" uniquement pour les actions
       d'administration (inviter un utilisateur, etc.) et
       pour générer des identifiants séquentiels.
   Déployé par Vercel comme fonction serverless (voir
   vercel.json : /api/(.*) → api/index.js). Pas d'app.listen
   ici, Vercel gère le serveur HTTP.
   ========================================================= */
'use strict';

const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !ANON_KEY || !SERVICE_KEY) {
  console.error('SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY manquants.');
}

const adminClient = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

function userClient(req) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  return createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${token}` } }
  });
}

/* ---------- camelCase (API/JS) <-> snake_case (Postgres) ---------- */
const toCamel = (s) => s.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
const toSnake = (s) => s.replace(/[A-Z]/g, (m) => '_' + m.toLowerCase());

function camelize(row) {
  if (Array.isArray(row)) return row.map(camelize);
  if (row === null || typeof row !== 'object') return row;
  const out = {};
  for (const [k, v] of Object.entries(row)) out[toCamel(k)] = v;
  return out;
}
function snakeize(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[toSnake(k)] = v;
  }
  return out;
}

function ok(res, data, status = 200) {
  return res.status(status).json(camelize(data));
}
function fail(res, status, error) {
  return res.status(status).json({ error });
}

/* ---------- Dates ---------- */
const dt = {
  parse: (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); },
  iso: (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
  add: (s, n) => { const d = dt.parse(s); d.setDate(d.getDate() + n); return dt.iso(d); },
  diff: (a, b) => Math.round((dt.parse(b) - dt.parse(a)) / 86400000),
  isWeekend: (s) => [0, 6].includes(dt.parse(s).getDay())
};
const today = () => dt.iso(new Date());
const isLate = (t) => t.status !== 'termine' && t.due && t.due < today();

/* ---------- Identifiants séquentiels (comptés côté service role
   pour éviter les collisions entre utilisateurs qui ne voient
   chacun qu'une partie des lignes via RLS) ---------- */
async function nextId(table, prefix, pad = 3) {
  const [id] = await nextIds(table, prefix, 1, pad);
  return id;
}

// Allocates `count` sequential ids in one table scan. Needed whenever a
// caller wants several ids from the same table before any of them is
// actually inserted (e.g. building an array of rows for a single batch
// insert) — calling nextId() in a loop in that situation reads the same
// "current max" every time and hands back the same id repeatedly, since
// nothing new has been inserted yet for it to see.
async function nextIds(table, prefix, count, pad = 3) {
  const { data, error } = await adminClient.from(table).select('id');
  if (error) throw error;
  const nums = (data || []).map((r) => {
    const m = String(r.id || '').match(/(\d+)$/);
    return m ? parseInt(m[1], 10) : 0;
  });
  const start = (nums.length ? Math.max(...nums) : 0) + 1;
  return Array.from({ length: count }, (_, i) => prefix + String(start + i).padStart(pad, '0'));
}

/* ---------- Auth middleware ---------- */
async function requireAuth(req, res, next) {
  try {
    const supa = userClient(req);
    const { data, error } = await supa.auth.getUser();
    if (error || !data.user) return fail(res, 401, 'unauthorized');
    req.supa = supa;
    req.userId = data.user.id;
    next();
  } catch (e) {
    fail(res, 401, 'unauthorized');
  }
}

async function requireAdmin(req, res, next) {
  const { data, error } = await req.supa.from('profiles').select('role,active').eq('id', req.userId).single();
  if (error || !data || data.role !== 'admin' || !data.active) return fail(res, 403, 'forbidden');
  next();
}

/* Ingénieur = a company. Rejects admin and assistant alike. */
async function requireIngenieur(req, res, next) {
  const { data, error } = await req.supa.from('profiles').select('role,active').eq('id', req.userId).single();
  if (error || !data || data.role !== 'ingenieur' || !data.active) return fail(res, 403, 'forbidden');
  next();
}

/* The caller's effective company: their own id if ingénieur, their
   employer's id if assistant. Mirrors my_company() in schema.sql — used
   server-side wherever we must stamp company_id on a new row (RLS's
   WITH CHECK enforces it's correct, this just computes what to send). */
async function getCallerCompany(supa, userId) {
  const { data, error } = await supa.from('profiles').select('role,company_id').eq('id', userId).single();
  if (error || !data) throw new Error('profile_not_found');
  return data.role === 'assistant' ? data.company_id : userId;
}

function throwIfError({ error }) {
  if (error) throw error;
}

/* =========================================================
   Décorateurs — même logique métier que l'ancien server.js,
   mais chaque relation est récupérée avec une requête ciblée
   (RLS restreint déjà ce qu'un ingénieur peut voir).
   ========================================================= */
async function decorateProject(supa, p) {
  const t = today();
  const [{ data: client }, { data: team }, { data: ts }, { data: pTasks }, { data: mats }] = await Promise.all([
    p.client_id ? supa.from('clients').select('company,contact').eq('id', p.client_id).maybeSingle() : { data: null },
    supa.from('workers').select('id').eq('project_id', p.id),
    supa.from('timesheets').select('status,hours').eq('project_id', p.id).eq('date', t),
    supa.from('tasks').select('status,due').eq('project_id', p.id),
    supa.from('project_materials').select('qty,article_id').eq('project_id', p.id)
  ]);
  const present = (ts || []).filter((x) => x.status !== 'absent');
  const phases = p.phases || [];
  const late = phases.filter((ph) => ph.progress < 100 && ph.end < t);
  const daysLate = late.length ? Math.max(...late.map((ph) => dt.diff(ph.end, t))) : 0;

  let materialsCost = 0;
  if (mats && mats.length) {
    const articleIds = [...new Set(mats.map((m) => m.article_id))];
    const { data: arts } = await supa.from('articles').select('id,price').in('id', articleIds);
    const priceById = Object.fromEntries((arts || []).map((a) => [a.id, a.price]));
    materialsCost = mats.reduce((s, m) => s + m.qty * (priceById[m.article_id] || 0), 0);
  }

  return {
    ...p,
    client_name: client ? client.company : '—',
    client_contact: client ? client.contact : '—',
    team_size: (team || []).length,
    present_today: present.length,
    hours_today: present.reduce((s, x) => s + Number(x.hours || 0), 0),
    remaining: p.budget - p.spent,
    burn: p.budget ? Math.round((p.spent / p.budget) * 100) : 0,
    tasks_total: (pTasks || []).length,
    tasks_late: (pTasks || []).filter(isLate).length,
    tasks_done: (pTasks || []).filter((x) => x.status === 'termine').length,
    days_late: daysLate,
    late_phases: late.map((ph) => ph.name),
    materials_count: (mats || []).length,
    materials_cost: materialsCost
  };
}

async function decorateMaterial(supa, m) {
  const [{ data: a }, { data: p }] = await Promise.all([
    supa.from('articles').select('*').eq('id', m.article_id).maybeSingle(),
    m.project_id ? supa.from('projects').select('name').eq('id', m.project_id).maybeSingle() : { data: null }
  ]);
  return {
    ...m,
    name: a ? a.name : '—', ref: a ? a.ref : '—', unit: a ? a.unit : '',
    category: a ? a.category : '—', price: a ? a.price : 0,
    total: a ? m.qty * a.price : 0,
    stock: a ? a.stock : 0, min: a ? a.min : 0,
    stock_status: a ? a.stock_status : 'ok',
    supplier: a ? a.supplier : '—',
    project_name: p ? p.name : '—'
  };
}

async function decorateSupplier(supa, s) {
  const { data: arts } = await supa.from('articles').select('id,stock,price,stock_status').eq('supplier_id', s.id);
  const artIds = (arts || []).map((a) => a.id);
  const { data: moves } = artIds.length
    ? await supa.from('project_materials').select('qty,article_id,date,project_id').in('article_id', artIds)
    : { data: [] };
  const priceById = Object.fromEntries((arts || []).map((a) => [a.id, a.price]));
  const purchases = (moves || []).reduce((sum, m) => sum + m.qty * (priceById[m.article_id] || 0), 0);
  const lastMove = (moves || []).length ? moves.slice().sort((x, y) => y.date.localeCompare(x.date))[0].date : null;
  return {
    ...s,
    article_count: (arts || []).length,
    featured_count: (s.featured || []).length,
    alerts: (arts || []).filter((a) => a.stock_status !== 'ok').length,
    ruptures: (arts || []).filter((a) => a.stock_status === 'rupture').length,
    stock_value: (arts || []).reduce((sum, a) => sum + a.stock * a.price, 0),
    purchases,
    last_move: lastMove,
    project_count: new Set((moves || []).map((m) => m.project_id)).size
  };
}

async function decorateClient(supa, c) {
  const { data: ps } = await supa.from('projects').select('budget,status,start,name').eq('client_id', c.id);
  const list = ps || [];
  return {
    ...c,
    project_count: list.length,
    total_amount: list.reduce((s, p) => s + p.budget, 0),
    open_count: list.filter((p) => p.status !== 'termine').length,
    last_project: list.length ? list.slice().sort((a, b) => b.start.localeCompare(a.start))[0].name : '—'
  };
}

async function decorateWorker(supa, w) {
  const t = today();
  const [{ data: p }, { data: entries }, { data: monthRows }] = await Promise.all([
    w.project_id ? supa.from('projects').select('name,status').eq('id', w.project_id).maybeSingle() : { data: null },
    // Un ouvrier peut avoir plusieurs pointages le même jour (plusieurs
    // chantiers dans la même journée) depuis que timesheets n'a plus de
    // contrainte unique(date, worker_id) — voir POST /timesheets.
    supa.from('timesheets').select('*').eq('worker_id', w.id).eq('date', t),
    supa.from('timesheets').select('hours,date').eq('worker_id', w.id).gte('date', dt.add(t, -30))
  ]);
  const monthHours = (monthRows || []).reduce((s, r) => s + Number(r.hours || 0), 0);
  // Même règle que scheduledTimesheetRows (feuille de pointage) : un ouvrier
  // affecté à un chantier en cours mais pas encore pointé aujourd'hui est
  // "absent" (à pointer), pas "non planifié" — sinon la fiche chantier et
  // la feuille de pointage affichent deux statuts différents pour le même
  // ouvrier le même jour.
  const scheduledToday = !!(p && p.status !== 'termine');
  const todayEntries = entries || [];
  const todayStatus = todayEntries.some((e) => e.status === 'present') ? 'present'
    : todayEntries.some((e) => e.status === 'retard') ? 'retard'
    : todayEntries.length ? 'absent'
    : (scheduledToday ? 'absent' : 'non_planifie');
  return {
    ...w,
    project_name: p ? p.name : 'Non affecté',
    today_status: todayStatus,
    today_entries: todayEntries,
    today_hours: todayEntries.reduce((s, e) => s + Number(e.hours || 0), 0),
    month_hours: Math.round(monthHours),
    month_cost: Math.round(monthHours * w.rate)
  };
}

async function moveStock(supa, articleId, deltaQty) {
  const { data: a } = await supa.from('articles').select('*').eq('id', articleId).maybeSingle();
  if (!a) throw new Error('Article introuvable');
  const stock = Math.max(0, a.stock - deltaQty);
  const stockStatus = stock === 0 ? 'rupture' : stock < a.min ? 'faible' : 'ok';
  const patch = { stock, stock_status: stockStatus };
  if (deltaQty > 0) patch.last_entry = today();
  throwIfError(await supa.from('articles').update(patch).eq('id', articleId));
  return a;
}

// Recomputes the project's "matériaux" expense line and total spend from
// the live project_materials rows, instead of incrementing/decrementing a
// running total on every create/edit/delete. The old delta-based version
// could drift from reality (each step rounded separately, and any call
// that ran twice or partially — a retried request, a double-clicked
// stepper — left a residual balance with nothing to reconcile it back to
// the real allocations). This is called AFTER project_materials already
// reflects its final state, so it's always exactly right.
async function recomputeProjectSpend(supa, projectId) {
  const { data: mats } = await supa.from('project_materials').select('qty,article_id').eq('project_id', projectId);
  const articleIds = [...new Set((mats || []).map((m) => m.article_id))];
  const { data: arts } = articleIds.length
    ? await supa.from('articles').select('id,price').in('id', articleIds)
    : { data: [] };
  const priceById = Object.fromEntries((arts || []).map((a) => [a.id, a.price]));
  const materialsCost = Math.round((mats || []).reduce((s, m) => s + m.qty * (priceById[m.article_id] || 0), 0));

  const key = `DEP-${projectId}-materiaux`;
  if (materialsCost > 0) {
    throwIfError(await supa.from('expenses').upsert({
      id: key, project_id: projectId, category: 'materiaux', label: 'Matériaux', amount: materialsCost
    }));
  } else {
    await supa.from('expenses').delete().eq('id', key);
  }

  const { data: allExpenses } = await supa.from('expenses').select('amount').eq('project_id', projectId);
  const spent = Math.round((allExpenses || []).reduce((s, e) => s + Number(e.amount || 0), 0));
  throwIfError(await supa.from('projects').update({ spent }).eq('id', projectId));
}

// "Progression globale" (projects.progress) and the "en_retard" alert
// status were plain stored fields, set once at creation/edit and never
// touched again — a task being completed, added or removed never fed
// back into either one, so the top-of-page percentage and every "late"
// badge/pill fed by it (dashboard sort order, nav pills, planning Gantt
// colouring) silently drifted from the real state of the project's tasks.
// Recomputed the same way as the budget above: derived fresh from the
// live tasks after every create/update/delete, never incremented.
// "termine" is a deliberate closure the ingénieur sets by hand and is
// never overridden here; a project with no tasks yet keeps whatever
// value was set manually (there is nothing real to derive it from).
async function recomputeProjectProgress(supa, projectId) {
  const { data: proj } = await supa.from('projects').select('status,end').eq('id', projectId).maybeSingle();
  if (!proj || proj.status === 'termine') return;
  const { data: tasks } = await supa.from('tasks').select('progress,status,due').eq('project_id', projectId);
  if (!tasks || !tasks.length) return;

  const progress = Math.round(tasks.reduce((s, t) => s + Number(t.progress || 0), 0) / tasks.length);
  const hasOverdueTask = tasks.some(isLate);
  const projectOverdue = proj.end && proj.end < today() && progress < 100;
  const status = (hasOverdueTask || projectOverdue) ? 'en_retard' : (progress > 0 ? 'en_cours' : 'en_preparation');

  throwIfError(await supa.from('projects').update({ progress, status }).eq('id', projectId));
}

/* =========================================================
   Express
   ========================================================= */
const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const ALLOWED_SIGNUP_DOMAIN = 'batipilot.tn';
const isAllowedDomain = (email) => new RegExp(`@${ALLOWED_SIGNUP_DOMAIN}$`, 'i').test(String(email || ''));

/* ---- Inscription publique — pas de requireAuth : n'importe qui peut
   appeler cette route, donc la validation de domaine se fait ici,
   côté serveur, et non dans le formulaire (qui peut être contourné). Le
   compte est créé désactivé ; un admin doit l'approuver depuis /utilisateurs. */
app.post('/api/v1/auth/signup', async (req, res) => {
  try {
    const { email, password, fullName } = req.body || {};
    if (!email || !isAllowedDomain(email)) {
      return res.status(400).json({ error: 'domain_not_allowed', message: `Utilisez une adresse e-mail @${ALLOWED_SIGNUP_DOMAIN}.` });
    }
    if (!password || password.length < 6) {
      return res.status(400).json({ error: 'weak_password', message: 'Le mot de passe doit contenir au moins 6 caractères.' });
    }
    const { data, error } = await adminClient.auth.admin.createUser({
      email, password, email_confirm: true, user_metadata: { full_name: fullName || '' }
    });
    if (error) return res.status(400).json({ error: error.message });
    await adminClient.from('profiles').update({ active: false }).eq('id', data.user.id);
    res.status(201).json({ ok: true, message: 'Compte créé. Un administrateur doit approuver votre accès avant votre première connexion.' });
  } catch (e) {
    res.status(500).json({ error: e.message || 'server_error' });
  }
});

const api = express.Router();
api.use(requireAuth);

/* ---- Mon profil (n'importe quel utilisateur connecté, pas admin requis) ---- */
api.get('/me', async (req, res, next) => {
  try {
    const { data, error } = await req.supa.from('profiles').select('*').eq('id', req.userId).maybeSingle();
    if (error) throw error;
    ok(res, data);
  } catch (e) { next(e); }
});

api.patch('/me', async (req, res, next) => {
  try {
    const patch = snakeize(req.body || {});
    // role/active are ignored here even before the DB reaches the trigger
    // that blocks them for non-admin callers — defense in depth.
    delete patch.id; delete patch.role; delete patch.active; delete patch.email; delete patch.created_at;
    const { data, error } = await req.supa.from('profiles').update(patch).eq('id', req.userId).select().maybeSingle();
    if (error) throw error;
    ok(res, data);
  } catch (e) { next(e); }
});

/* ---- Meta ---- */
api.get('/meta', async (req, res) => {
  const supa = req.supa;
  const counts = {};
  for (const t of ['projects', 'clients', 'workers', 'articles', 'tasks', 'suppliers']) {
    const { count } = await supa.from(t).select('id', { count: 'exact', head: true });
    counts[t] = count || 0;
  }
  ok(res, { today: today(), mode: 'supabase', counts: null }, 200);
  return res.status(200).json({ today: today(), mode: 'supabase', counts });
});

/* ---- Dashboard ---- */
api.get('/dashboard/kpis', async (req, res, next) => {
  try {
    const supa = req.supa;
    const t = today();
    const { data: projects } = await supa.from('projects').select('*');
    const active = (projects || []).filter((x) => x.status !== 'termine');
    const done = (projects || []).filter((x) => x.status === 'termine');
    const ts = await scheduledTimesheetRows(supa, t);
    const present = ts.filter((x) => x.status !== 'absent');
    const { data: tasks } = await supa.from('tasks').select('status,due');
    const budget = active.reduce((s, x) => s + x.budget, 0);
    const spent = active.reduce((s, x) => s + x.spent, 0);
    ok(res, {
      active_projects: active.length,
      done_projects: done.length,
      scheduled: ts.length,
      present: present.length,
      absent: ts.length - present.length,
      hours_today: present.reduce((s, x) => s + Number(x.hours || 0), 0),
      late_tasks: (tasks || []).filter((t2) => isLate({ status: t2.status, due: t2.due })).length,
      late_projects: active.filter((x) => x.status === 'en_retard').length,
      budget, spent, remaining: budget - spent,
      burn: budget ? Math.round((spent / budget) * 100) : 0
    });
  } catch (e) { next(e); }
});

api.get('/dashboard/activity', async (req, res, next) => {
  try {
    const { data } = await req.supa.from('activity').select('*').order('id', { ascending: false }).limit(20);
    ok(res, data || []);
  } catch (e) { next(e); }
});

/* ---- Projects ---- */
api.get('/projects', async (req, res, next) => {
  try {
    let q = req.supa.from('projects').select('*');
    if (req.query.status && req.query.status !== 'tous') q = q.eq('status', req.query.status);
    const { data, error } = await q;
    if (error) throw error;
    let list = data || [];
    if (req.query.q) {
      const s = String(req.query.q).toLowerCase();
      list = list.filter((x) => (x.name + x.city + x.address + x.ref).toLowerCase().includes(s));
    }
    const decorated = await Promise.all(list.map((p) => decorateProject(req.supa, p)));
    ok(res, decorated);
  } catch (e) { next(e); }
});

api.get('/projects/:id', async (req, res, next) => {
  try {
    const { data: p, error } = await req.supa.from('projects').select('*').eq('id', req.params.id).maybeSingle();
    if (error) throw error;
    if (!p) return fail(res, 404, 'not_found');
    ok(res, await decorateProject(req.supa, p));
  } catch (e) { next(e); }
});

api.post('/projects', async (req, res, next) => {
  try {
    const body = req.body || {};
    const picked = body.tasks || [];
    delete body.tasks;
    const id = await nextId('projects', 'PRJ-');
    const row = {
      id, ref: 'CHT-' + today().slice(0, 4) + '-' + id.slice(4),
      spent: 0, progress: 0, status: 'en_preparation', created_by: req.userId, company_id: req.userId,
      ...snakeize(body)
    };
    // nextId() derives "next" from a fresh table scan every call — calling
    // it once per picked task via Promise.all() runs them concurrently, so
    // every one reads the same "current max" and they all come back with
    // the identical id. nextIds() allocates the whole batch from one scan.
    const phaseTaskIds = await nextIds('tasks', 'TSK-', picked.length || 0);
    row.phases = picked.map((t, i) => ({
      taskId: phaseTaskIds[i], name: t.name, start: t.start, end: t.end, progress: 0, lead: t.assignee || row.manager
    }));
    throwIfError(await req.supa.from('projects').insert(row));
    // The creator must be a project_member before any further req.supa reads/writes
    // on this project (RLS scopes everything else through project_members) — use
    // the service-role client here since the row doesn't grant self-access yet.
    throwIfError(await adminClient.from('project_members').upsert({ project_id: id, user_id: req.userId }));
    if (picked.length) {
      const taskRows = picked.map((t, i) => ({
        id: phaseTaskIds[i], title: t.name, project_id: id,
        assignee: t.assignee || row.manager, priority: t.priority || 'moyenne',
        start: t.start, due: t.end, progress: 0, status: 'a_faire', created_at: today()
      }));
      throwIfError(await req.supa.from('tasks').insert(taskRows));
    }
    ok(res, await decorateProject(req.supa, row), 201);
  } catch (e) { next(e); }
});

api.patch('/projects/:id', async (req, res, next) => {
  try {
    const { data, error } = await req.supa.from('projects').update(snakeize(req.body || {})).eq('id', req.params.id).select().maybeSingle();
    if (error) throw error;
    if (!data) return fail(res, 404, 'not_found');
    ok(res, await decorateProject(req.supa, data));
  } catch (e) { next(e); }
});

api.delete('/projects/:id', async (req, res, next) => {
  try {
    throwIfError(await req.supa.from('projects').delete().eq('id', req.params.id));
    res.status(204).end();
  } catch (e) { next(e); }
});

/* ---- Clients ---- */
api.get('/clients', async (req, res, next) => {
  try {
    const { data, error } = await req.supa.from('clients').select('*');
    if (error) throw error;
    let list = data || [];
    if (req.query.status && req.query.status !== 'tous') list = list.filter((x) => x.status === req.query.status);
    if (req.query.q) {
      const s = String(req.query.q).toLowerCase();
      list = list.filter((x) => (x.company + x.contact + x.city + x.email).toLowerCase().includes(s));
    }
    ok(res, await Promise.all(list.map((c) => decorateClient(req.supa, c))));
  } catch (e) { next(e); }
});

api.get('/clients/:id', async (req, res, next) => {
  try {
    const { data: c, error } = await req.supa.from('clients').select('*').eq('id', req.params.id).maybeSingle();
    if (error) throw error;
    if (!c) return fail(res, 404, 'not_found');
    const [{ data: projects }, { data: quotes }] = await Promise.all([
      req.supa.from('projects').select('*').eq('client_id', c.id),
      req.supa.from('quotes').select('*').eq('client_id', c.id)
    ]);
    const decoratedProjects = await Promise.all((projects || []).map((p) => decorateProject(req.supa, p)));
    // "Historique commercial" was always sent as an empty array — the
    // count badge above it reads quotes.length (real), so it showed
    // "1 devis établi" with nothing underneath. Built from the actual
    // quotes; each one is a history line the UI already knows how to
    // render (type/ref/date/amount/note + quoteId to open/convert it).
    const history = (quotes || []).slice().sort((a, b) => b.date.localeCompare(a.date)).map((q) => ({
      type: 'Devis', ref: q.id, date: q.date, amount: q.total, note: q.title,
      quoteId: q.id, tone: q.status === 'accepte' ? 'ok' : 'info'
    }));
    ok(res, { ...(await decorateClient(req.supa, c)), projects: decoratedProjects.map(camelize), quotes: camelize(quotes || []), history });
  } catch (e) { next(e); }
});

api.post('/clients', async (req, res, next) => {
  try {
    const id = await nextId('clients', 'CLI-');
    const row = { id, status: 'actif', since: today(), city: 'Tunis', ...snakeize(req.body || {}), company_id: req.userId };
    throwIfError(await req.supa.from('clients').insert(row));
    ok(res, await decorateClient(req.supa, row), 201);
  } catch (e) { next(e); }
});

api.patch('/clients/:id', async (req, res, next) => {
  try {
    const { data, error } = await req.supa.from('clients').update(snakeize(req.body || {})).eq('id', req.params.id).select().maybeSingle();
    if (error) throw error;
    if (!data) return fail(res, 404, 'not_found');
    ok(res, await decorateClient(req.supa, data));
  } catch (e) { next(e); }
});

api.delete('/clients/:id', async (req, res, next) => {
  try {
    throwIfError(await req.supa.from('clients').delete().eq('id', req.params.id));
    res.status(204).end();
  } catch (e) { next(e); }
});

/* ---- Workers ---- */
api.get('/workers', async (req, res, next) => {
  try {
    let q = req.supa.from('workers').select('*');
    if (req.query.projectId && req.query.projectId !== 'tous') q = q.eq('project_id', req.query.projectId);
    if (req.query.trade && req.query.trade !== 'tous') q = q.eq('trade', req.query.trade);
    const { data, error } = await q;
    if (error) throw error;
    let list = data || [];
    if (req.query.q) {
      const s = String(req.query.q).toLowerCase();
      list = list.filter((x) => (x.name + x.trade + (x.matricule || '')).toLowerCase().includes(s));
    }
    ok(res, await Promise.all(list.map((w) => decorateWorker(req.supa, w))));
  } catch (e) { next(e); }
});

api.get('/workers/:id', async (req, res, next) => {
  try {
    const { data: w, error } = await req.supa.from('workers').select('*').eq('id', req.params.id).maybeSingle();
    if (error) throw error;
    if (!w) return fail(res, 404, 'not_found');
    ok(res, await decorateWorker(req.supa, w));
  } catch (e) { next(e); }
});

api.post('/workers', async (req, res, next) => {
  try {
    const id = await nextId('workers', 'OUV-');
    const companyId = await getCallerCompany(req.supa, req.userId);
    const row = { id, trade: 'Maçon', rate: 15, status: 'actif', since: today(), ...snakeize(req.body || {}), company_id: companyId };
    throwIfError(await req.supa.from('workers').insert(row));
    ok(res, await decorateWorker(req.supa, row), 201);
  } catch (e) { next(e); }
});

api.patch('/workers/:id', async (req, res, next) => {
  try {
    const { data, error } = await req.supa.from('workers').update(snakeize(req.body || {})).eq('id', req.params.id).select().maybeSingle();
    if (error) throw error;
    if (!data) return fail(res, 404, 'not_found');
    ok(res, await decorateWorker(req.supa, data));
  } catch (e) { next(e); }
});

api.delete('/workers/:id', async (req, res, next) => {
  try {
    throwIfError(await req.supa.from('workers').delete().eq('id', req.params.id));
    res.status(204).end();
  } catch (e) { next(e); }
});

/* ---- Timesheets ----
   Un ouvrier simplement affecté à un chantier (workers.project_id) n'a pas
   pour autant de ligne dans `timesheets` tant que personne ne l'a pointé ce
   jour-là : sans complément, la feuille de pointage d'un chantier tout
   juste doté d'ouvriers restait vide. `scheduledTimesheetRows` complète
   donc les lignes réelles du jour par une ligne "absent" provisoire pour
   chaque ouvrier actif affecté à un chantier en cours qui n'a pas encore
   été pointé, afin qu'il apparaisse immédiatement sur la feuille — prêt à
   être modifié — plutôt que de rester invisible jusqu'à la création
   manuelle d'un premier pointage. */
async function scheduledTimesheetRows(supa, date) {
  const { data: realRows, error } = await supa.from('timesheets').select('*').eq('date', date);
  if (error) throw error;
  const { data: workers } = await supa.from('workers').select('id,name,trade,project_id,status').eq('status', 'actif').not('project_id', 'is', null);
  const { data: projects } = await supa.from('projects').select('id,name,status');
  const nameById = Object.fromEntries((projects || []).map((p) => [p.id, p.name]));
  const activeProjectIds = new Set((projects || []).filter((p) => p.status !== 'termine').map((p) => p.id));

  const pointedWorkerIds = new Set((realRows || []).map((r) => r.worker_id));
  const placeholders = (workers || [])
    .filter((w) => activeProjectIds.has(w.project_id) && !pointedWorkerIds.has(w.id))
    .map((w) => ({
      id: `PTG-${date}-${w.id}`, date, worker_id: w.id, worker: w.name, trade: w.trade,
      project_id: w.project_id, in: null, out: null, break_min: 0, hours: 0,
      status: 'absent', note: '', pending: true
    }));

  return [...(realRows || []), ...placeholders].map((r) => ({ ...r, project_name: nameById[r.project_id] || '—' }));
}

api.get('/timesheets', async (req, res, next) => {
  try {
    const date = req.query.date || today();
    let rows = await scheduledTimesheetRows(req.supa, date);
    if (req.query.projectId && req.query.projectId !== 'tous') rows = rows.filter((r) => r.project_id === req.query.projectId);
    if (req.query.trade && req.query.trade !== 'tous') rows = rows.filter((r) => r.trade === req.query.trade);
    if (req.query.status && req.query.status !== 'tous') rows = rows.filter((r) => r.status === req.query.status);
    if (req.query.q) rows = rows.filter((r) => r.worker.toLowerCase().includes(String(req.query.q).toLowerCase()));
    // Regroupe les lignes d'un même ouvrier (plusieurs chantiers dans la
    // journée) plutôt que de les laisser dispersées dans l'ordre de retour
    // de la requête.
    rows.sort((a, b) => a.worker.localeCompare(b.worker) || (a.in ?? 9999) - (b.in ?? 9999));
    ok(res, rows);
  } catch (e) { next(e); }
});

api.get('/timesheets/summary', async (req, res, next) => {
  try {
    const date = req.query.date || today();
    const rows = await scheduledTimesheetRows(req.supa, date);
    const present = rows.filter((r) => r.status !== 'absent');
    const workerIds = [...new Set(present.map((r) => r.worker_id))];
    const { data: workers } = workerIds.length ? await req.supa.from('workers').select('id,rate').in('id', workerIds) : { data: [] };
    const rateById = Object.fromEntries((workers || []).map((w) => [w.id, w.rate]));
    // Un ouvrier avec deux pointages le même jour (deux chantiers) ne doit
    // compter que pour UNE personne dans "prévus/présents/absents/retards" —
    // seules les heures et le coût s'additionnent naturellement sur les
    // lignes. On calcule donc ces quatre compteurs sur des ensembles
    // d'ouvriers distincts plutôt que sur le nombre de lignes.
    const distinctWorkers = (pred) => new Set(rows.filter(pred).map((r) => r.worker_id)).size;
    ok(res, {
      date,
      scheduled: new Set(rows.map((r) => r.worker_id)).size,
      // "présent" = pas absent (couvre aussi "retard", comme avant le
      // support multi-chantier) ; "late" reste un sous-ensemble affiché à
      // part ("X arrivées tardives"), pas une catégorie exclusive.
      present: distinctWorkers((r) => r.status !== 'absent'),
      absent: distinctWorkers((r) => r.status === 'absent'),
      late: distinctWorkers((r) => r.status === 'retard'),
      hours: present.reduce((s, r) => s + Number(r.hours || 0), 0),
      cost: Math.round(present.reduce((s, r) => s + Number(r.hours || 0) * (rateById[r.worker_id] || 15), 0))
    });
  } catch (e) { next(e); }
});

const toHHMMServer = (min) => min == null ? '?' : `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

/* Un ouvrier peut être pointé sur plusieurs chantiers le même jour (ex.
   7h-12h sur un chantier, 13h-fin sur un autre) — timesheets n'a donc
   plus de contrainte unique(date, worker_id). La seule règle métier que
   ça laisse à faire respecter : il ne peut pas être à deux endroits en
   même temps. `excludeId` sert au PATCH, pour ne pas comparer une ligne
   à elle-même. */
async function assertNoTimeOverlap(supa, { workerId, date, in: inMin, out: outMin, status, excludeId }) {
  if (status === 'absent' || inMin == null || outMin == null) return;
  let q = supa.from('timesheets').select('id,in,out,project_id').eq('worker_id', workerId).eq('date', date).neq('status', 'absent');
  if (excludeId) q = q.neq('id', excludeId);
  const { data: others, error } = await q;
  if (error) throw error;
  const conflict = (others || []).find((o) => o.in != null && o.out != null && inMin < o.out && o.in < outMin);
  if (conflict) {
    const { data: proj } = conflict.project_id
      ? await supa.from('projects').select('name').eq('id', conflict.project_id).maybeSingle()
      : { data: null };
    const err = new Error(
      `Chevauchement horaire : cet ouvrier est déjà pointé${proj ? ' sur ' + proj.name : ''} de ${toHHMMServer(conflict.in)} à ${toHHMMServer(conflict.out)} ce jour-là.`
    );
    err.status = 409;
    throw err;
  }
}

api.post('/timesheets', async (req, res, next) => {
  try {
    const entry = req.body || {};
    const date = entry.date || today();
    await assertNoTimeOverlap(req.supa, { workerId: entry.workerId, date, in: entry.in, out: entry.out, status: entry.status });
    const { data: worker } = await req.supa.from('workers').select('name,trade').eq('id', entry.workerId).maybeSingle();
    const hours = Math.max(0, (entry.out - entry.in - entry.breakMin) / 60);
    const id = await nextId('timesheets', 'PTG-');
    const row = {
      id, date, worker_id: entry.workerId,
      worker: worker ? worker.name : '—', trade: worker ? worker.trade : '—',
      project_id: entry.projectId, in: entry.in, out: entry.out, break_min: entry.breakMin,
      hours, status: entry.status || (entry.in > 435 ? 'retard' : 'present'), note: entry.note || ''
    };
    throwIfError(await req.supa.from('timesheets').insert(row));
    ok(res, row, 201);
  } catch (e) { next(e); }
});

api.patch('/timesheets/:id', async (req, res, next) => {
  try {
    const patch = snakeize(req.body || {});
    const { data: existing } = await req.supa.from('timesheets').select('*').eq('id', req.params.id).maybeSingle();
    if (!existing) return fail(res, 404, 'not_found');
    const merged = { ...existing, ...patch };
    if (patch.in != null || patch.out != null || patch.break_min != null) {
      merged.hours = Math.max(0, (merged.out - merged.in - (merged.break_min || 0)) / 60);
    }
    if (patch.in != null || patch.out != null || patch.status != null) {
      await assertNoTimeOverlap(req.supa, {
        workerId: merged.worker_id, date: merged.date, in: merged.in, out: merged.out,
        status: merged.status, excludeId: req.params.id
      });
    }
    const { data, error } = await req.supa.from('timesheets').update(merged).eq('id', req.params.id).select().maybeSingle();
    if (error) throw error;
    ok(res, data);
  } catch (e) { next(e); }
});

api.delete('/timesheets/:id', async (req, res, next) => {
  try {
    throwIfError(await req.supa.from('timesheets').delete().eq('id', req.params.id));
    res.status(204).end();
  } catch (e) { next(e); }
});

/* ---- Articles ---- */
api.get('/articles', async (req, res, next) => {
  try {
    let q = req.supa.from('articles').select('*');
    if (req.query.category && req.query.category !== 'tous') q = q.eq('category', req.query.category);
    if (req.query.stockStatus && req.query.stockStatus !== 'tous') q = q.eq('stock_status', req.query.stockStatus);
    const { data, error } = await q;
    if (error) throw error;
    let list = data || [];
    if (req.query.q) {
      const s = String(req.query.q).toLowerCase();
      list = list.filter((a) => (a.name + a.ref + a.supplier + a.category).toLowerCase().includes(s));
    }
    ok(res, list);
  } catch (e) { next(e); }
});

api.get('/articles/:id', async (req, res, next) => {
  try {
    const { data, error } = await req.supa.from('articles').select('*').eq('id', req.params.id).maybeSingle();
    if (error) throw error;
    if (!data) return fail(res, 404, 'not_found');
    ok(res, data);
  } catch (e) { next(e); }
});

api.post('/articles', async (req, res, next) => {
  try {
    const id = await nextId('articles', 'ART-');
    const body = req.body || {};
    const stockStatus = body.stock === 0 ? 'rupture' : body.stock < body.min ? 'faible' : 'ok';
    const row = {
      id, ref: 'MAT-' + id.slice(4), location: 'Dépôt central Tunis', last_entry: today(),
      ...snakeize(body), stock_status: stockStatus, company_id: req.userId
    };
    throwIfError(await req.supa.from('articles').insert(row));
    ok(res, row, 201);
  } catch (e) { next(e); }
});

api.patch('/articles/:id', async (req, res, next) => {
  try {
    const patch = snakeize(req.body || {});
    const { data: existing } = await req.supa.from('articles').select('*').eq('id', req.params.id).maybeSingle();
    if (!existing) return fail(res, 404, 'not_found');
    const merged = { ...existing, ...patch };
    merged.stock_status = merged.stock === 0 ? 'rupture' : merged.stock < merged.min ? 'faible' : 'ok';
    const { data, error } = await req.supa.from('articles').update(merged).eq('id', req.params.id).select().maybeSingle();
    if (error) throw error;
    ok(res, data);
  } catch (e) { next(e); }
});

api.delete('/articles/:id', async (req, res, next) => {
  try {
    throwIfError(await req.supa.from('articles').delete().eq('id', req.params.id));
    res.status(204).end();
  } catch (e) { next(e); }
});

/* ---- Tasks ---- */
api.get('/tasks', async (req, res, next) => {
  try {
    let q = req.supa.from('tasks').select('*');
    if (req.query.projectId && req.query.projectId !== 'tous') q = q.eq('project_id', req.query.projectId);
    if (req.query.status && req.query.status !== 'tous') q = q.eq('status', req.query.status);
    if (req.query.priority && req.query.priority !== 'tous') q = q.eq('priority', req.query.priority);
    const { data, error } = await q;
    if (error) throw error;
    let list = data || [];
    if (req.query.q) {
      const s = String(req.query.q).toLowerCase();
      list = list.filter((t) => (t.title + t.assignee).toLowerCase().includes(s));
    }
    const projIds = [...new Set(list.map((t) => t.project_id).filter(Boolean))];
    const { data: projs } = projIds.length ? await req.supa.from('projects').select('id,name').in('id', projIds) : { data: [] };
    const nameById = Object.fromEntries((projs || []).map((p) => [p.id, p.name]));
    ok(res, list.map((t) => ({ ...t, project_name: nameById[t.project_id] || '—', late: isLate(t) })));
  } catch (e) { next(e); }
});

api.post('/tasks', async (req, res, next) => {
  try {
    const id = await nextId('tasks', 'TSK-');
    const row = { id, progress: 0, status: 'a_faire', created_at: today(), ...snakeize(req.body || {}) };
    throwIfError(await req.supa.from('tasks').insert(row));
    // A task added after project creation (the everyday "+ Ajouter" flow)
    // must also land in the project's `phases` snapshot — that's the only
    // thing "Avancement par lot" and the Gantt read (see PATCH/DELETE
    // below, which already keep it in sync for edits/removals; this was
    // the missing case for new tasks).
    if (row.project_id) {
      const { data: p } = await req.supa.from('projects').select('phases').eq('id', row.project_id).maybeSingle();
      if (p) {
        const phases = [...(p.phases || []), {
          taskId: row.id, name: row.title, start: row.start, end: row.due, progress: row.progress, lead: row.assignee
        }];
        await req.supa.from('projects').update({ phases }).eq('id', row.project_id);
      }
      await recomputeProjectProgress(req.supa, row.project_id);
    }
    ok(res, row, 201);
  } catch (e) { next(e); }
});

api.patch('/tasks/:id', async (req, res, next) => {
  try {
    const { data: t, error } = await req.supa.from('tasks').update(snakeize(req.body || {})).eq('id', req.params.id).select().maybeSingle();
    if (error) throw error;
    if (!t) return fail(res, 404, 'not_found');
    if (t.project_id) {
      const { data: p } = await req.supa.from('projects').select('phases').eq('id', t.project_id).maybeSingle();
      if (p && Array.isArray(p.phases)) {
        const phases = p.phases.map((ph) => ph.taskId === t.id
          ? { ...ph, name: t.title, start: t.start, end: t.due, progress: t.progress, lead: t.assignee }
          : ph);
        await req.supa.from('projects').update({ phases }).eq('id', t.project_id);
      }
      await recomputeProjectProgress(req.supa, t.project_id);
    }
    ok(res, t);
  } catch (e) { next(e); }
});

api.delete('/tasks/:id', async (req, res, next) => {
  try {
    const { data: t } = await req.supa.from('tasks').select('*').eq('id', req.params.id).maybeSingle();
    if (t && t.project_id) {
      const { data: p } = await req.supa.from('projects').select('phases').eq('id', t.project_id).maybeSingle();
      if (p && Array.isArray(p.phases)) {
        const phases = p.phases.filter((ph) => ph.taskId !== t.id);
        await req.supa.from('projects').update({ phases }).eq('id', t.project_id);
      }
    }
    throwIfError(await req.supa.from('tasks').delete().eq('id', req.params.id));
    if (t && t.project_id) await recomputeProjectProgress(req.supa, t.project_id);
    res.status(204).end();
  } catch (e) { next(e); }
});

/* ---- Materials (project allocations) ---- */
api.get('/materials', async (req, res, next) => {
  try {
    let q = req.supa.from('project_materials').select('*');
    if (req.query.projectId && req.query.projectId !== 'tous') q = q.eq('project_id', req.query.projectId);
    if (req.query.articleId) q = q.eq('article_id', req.query.articleId);
    const { data, error } = await q;
    if (error) throw error;
    const list = (data || []).slice().sort((a, b) => b.date.localeCompare(a.date));
    ok(res, await Promise.all(list.map((m) => decorateMaterial(req.supa, m))));
  } catch (e) { next(e); }
});

api.post('/materials', async (req, res, next) => {
  try {
    const body = req.body || {};
    const { data: a } = await req.supa.from('articles').select('stock').eq('id', body.articleId).maybeSingle();
    if (!a) return fail(res, 400, 'Article introuvable');
    if (body.qty > a.stock) return fail(res, 400, 'stock_insuffisant');
    const { data: profile } = await req.supa.from('profiles').select('full_name').eq('id', req.userId).maybeSingle();
    const row = {
      id: 'AFF-' + Date.now().toString(36).toUpperCase(), date: today(),
      author: profile ? profile.full_name : '', note: '', ...snakeize(body)
    };
    throwIfError(await req.supa.from('project_materials').insert(row));
    await moveStock(req.supa, row.article_id, row.qty);
    await recomputeProjectSpend(req.supa, row.project_id);
    ok(res, await decorateMaterial(req.supa, row), 201);
  } catch (e) { next(e); }
});

api.patch('/materials/:id', async (req, res, next) => {
  try {
    const { data: item } = await req.supa.from('project_materials').select('*').eq('id', req.params.id).maybeSingle();
    if (!item) return fail(res, 404, 'not_found');
    const patch = req.body || {};
    if (patch.qty != null) {
      const { data: a } = await req.supa.from('articles').select('stock').eq('id', item.article_id).maybeSingle();
      const delta = patch.qty - item.qty;
      if (a && delta > a.stock) return fail(res, 400, 'stock_insuffisant');
      await moveStock(req.supa, item.article_id, delta);
    }
    const { data, error } = await req.supa.from('project_materials').update(snakeize(patch)).eq('id', req.params.id).select().maybeSingle();
    if (error) throw error;
    if (patch.qty != null) await recomputeProjectSpend(req.supa, item.project_id);
    ok(res, await decorateMaterial(req.supa, data));
  } catch (e) { next(e); }
});

api.delete('/materials/:id', async (req, res, next) => {
  try {
    const { data: item } = await req.supa.from('project_materials').select('*').eq('id', req.params.id).maybeSingle();
    if (item) {
      await moveStock(req.supa, item.article_id, -item.qty);
      throwIfError(await req.supa.from('project_materials').delete().eq('id', req.params.id));
      await recomputeProjectSpend(req.supa, item.project_id);
    }
    res.status(204).end();
  } catch (e) { next(e); }
});

/* ---- Suppliers ---- */
api.get('/suppliers', async (req, res, next) => {
  try {
    let q = req.supa.from('suppliers').select('*');
    if (req.query.status && req.query.status !== 'tous') q = q.eq('status', req.query.status);
    if (req.query.city && req.query.city !== 'tous') q = q.eq('city', req.query.city);
    const { data, error } = await q;
    if (error) throw error;
    let list = data || [];
    if (req.query.q) {
      const s = String(req.query.q).toLowerCase();
      list = list.filter((x) => (x.company + x.contact + x.city + x.specialty).toLowerCase().includes(s));
    }
    ok(res, await Promise.all(list.map((s) => decorateSupplier(req.supa, s))));
  } catch (e) { next(e); }
});

api.get('/suppliers/:id', async (req, res, next) => {
  try {
    const { data: s, error } = await req.supa.from('suppliers').select('*').eq('id', req.params.id).maybeSingle();
    if (error) throw error;
    if (!s) return fail(res, 404, 'not_found');
    const { data: arts } = await req.supa.from('articles').select('*').eq('supplier_id', s.id);
    const articles = (arts || [])
      .map((a) => ({ ...a, is_featured: (s.featured || []).includes(a.id) }))
      .sort((a, b) => b.is_featured - a.is_featured || a.name.localeCompare(b.name));
    const artIds = (arts || []).map((a) => a.id);
    const { data: moves } = artIds.length
      ? await req.supa.from('project_materials').select('*').in('article_id', artIds)
      : { data: [] };
    const projIds = [...new Set((moves || []).map((m) => m.project_id).filter(Boolean))];
    const { data: projs } = projIds.length ? await req.supa.from('projects').select('id,name').in('id', projIds) : { data: [] };
    const nameById = Object.fromEntries((projs || []).map((p) => [p.id, p.name]));
    const priceById = Object.fromEntries((arts || []).map((a) => [a.id, a.price]));
    const unitById = Object.fromEntries((arts || []).map((a) => [a.id, a.unit]));
    const articleNameById = Object.fromEntries((arts || []).map((a) => [a.id, a.name]));
    const deliveries = (moves || [])
      .map((m) => ({
        id: m.id, date: m.date, qty: m.qty, unit: unitById[m.article_id], article: articleNameById[m.article_id],
        amount: m.qty * (priceById[m.article_id] || 0), project_name: nameById[m.project_id] || '—', project_id: m.project_id
      }))
      .sort((x, y) => y.date.localeCompare(x.date));
    ok(res, { ...(await decorateSupplier(req.supa, s)), articles: camelize(articles), deliveries: camelize(deliveries) });
  } catch (e) { next(e); }
});

api.post('/suppliers', async (req, res, next) => {
  try {
    const id = await nextId('suppliers', 'FRN-');
    const row = {
      id, since: today(), status: 'actif', featured: [], rating: 4, lead_days: 3,
      tax_id: '', payment: '30 jours fin de mois', note: '', ...snakeize(req.body || {}), company_id: req.userId
    };
    throwIfError(await req.supa.from('suppliers').insert(row));
    ok(res, row, 201);
  } catch (e) { next(e); }
});

api.patch('/suppliers/:id', async (req, res, next) => {
  try {
    const { data: existing } = await req.supa.from('suppliers').select('company').eq('id', req.params.id).maybeSingle();
    if (!existing) return fail(res, 404, 'not_found');
    const patch = snakeize(req.body || {});
    const { data: s, error } = await req.supa.from('suppliers').update(patch).eq('id', req.params.id).select().maybeSingle();
    if (error) throw error;
    if (patch.company && patch.company !== existing.company) {
      await req.supa.from('articles').update({ supplier: patch.company }).eq('supplier_id', req.params.id);
    }
    ok(res, s);
  } catch (e) { next(e); }
});

api.delete('/suppliers/:id', async (req, res, next) => {
  try {
    throwIfError(await req.supa.from('suppliers').delete().eq('id', req.params.id));
    res.status(204).end();
  } catch (e) { next(e); }
});

api.post('/suppliers/:id/featured/:articleId', async (req, res, next) => {
  try {
    const { data: s } = await req.supa.from('suppliers').select('featured').eq('id', req.params.id).maybeSingle();
    if (!s) return fail(res, 404, 'not_found');
    const featured = s.featured || [];
    const i = featured.indexOf(req.params.articleId);
    const next_ = i > -1 ? featured.filter((x) => x !== req.params.articleId) : [...featured, req.params.articleId];
    throwIfError(await req.supa.from('suppliers').update({ featured: next_ }).eq('id', req.params.id));
    ok(res, { featured: i === -1, count: next_.length });
  } catch (e) { next(e); }
});

/* ---- Task catalog ---- */
api.get('/task-catalog', async (req, res, next) => {
  try {
    const { data, error } = await req.supa.from('task_catalog').select('*');
    if (error) throw error;
    ok(res, data || []);
  } catch (e) { next(e); }
});

api.post('/task-catalog', async (req, res, next) => {
  try {
    const id = await nextId('task_catalog', 'CAT-');
    const row = { id, active: true, default_days: 10, ...snakeize(req.body || {}) };
    throwIfError(await req.supa.from('task_catalog').insert(row));
    ok(res, row, 201);
  } catch (e) { next(e); }
});

api.patch('/task-catalog/:id', async (req, res, next) => {
  try {
    const { data, error } = await req.supa.from('task_catalog').update(snakeize(req.body || {})).eq('id', req.params.id).select().maybeSingle();
    if (error) throw error;
    if (!data) return fail(res, 404, 'not_found');
    ok(res, data);
  } catch (e) { next(e); }
});

api.delete('/task-catalog/:id', async (req, res, next) => {
  try {
    throwIfError(await req.supa.from('task_catalog').delete().eq('id', req.params.id));
    res.status(204).end();
  } catch (e) { next(e); }
});

/* ---- Attachments ---- */
api.get('/attachments/:projectId', async (req, res, next) => {
  try {
    const { data, error } = await req.supa.from('attachments').select('*').eq('project_id', req.params.projectId);
    if (error) throw error;
    ok(res, (data || []).slice().sort((a, b) => b.date.localeCompare(a.date)));
  } catch (e) { next(e); }
});

api.post('/attachments/:projectId', async (req, res, next) => {
  try {
    const { data: profile } = await req.supa.from('profiles').select('full_name').eq('id', req.userId).maybeSingle();
    const row = {
      id: 'ATT-' + Date.now().toString(36).toUpperCase(), project_id: req.params.projectId,
      date: today(), author: profile ? profile.full_name : '', kind: 'document', ...snakeize(req.body || {})
    };
    throwIfError(await req.supa.from('attachments').insert(row));
    ok(res, row, 201);
  } catch (e) { next(e); }
});

api.delete('/attachments/:projectId/:id', async (req, res, next) => {
  try {
    throwIfError(await req.supa.from('attachments').delete().eq('id', req.params.id).eq('project_id', req.params.projectId));
    res.status(204).end();
  } catch (e) { next(e); }
});

/* ---- Quotes ---- */
api.get('/quotes', async (req, res, next) => {
  try {
    let q = req.supa.from('quotes').select('*');
    if (req.query.clientId) q = q.eq('client_id', req.query.clientId);
    const { data, error } = await q;
    if (error) throw error;
    ok(res, data || []);
  } catch (e) { next(e); }
});

api.get('/quotes/:id', async (req, res, next) => {
  try {
    const { data, error } = await req.supa.from('quotes').select('*').eq('id', req.params.id).maybeSingle();
    if (error) throw error;
    if (!data) return fail(res, 404, 'not_found');
    ok(res, data);
  } catch (e) { next(e); }
});

api.post('/quotes', async (req, res, next) => {
  try {
    const year = today().slice(0, 4);
    const id = await nextId('quotes', 'DEV-' + year + '-');
    const body = req.body || {};
    const row = {
      id, date: today(), status: 'en_attente', project_id: null, ...snakeize(body),
      total: (body.lines || []).reduce((s, l) => s + l.qty * l.price, 0), company_id: req.userId
    };
    throwIfError(await req.supa.from('quotes').insert(row));
    ok(res, row, 201);
  } catch (e) { next(e); }
});

api.patch('/quotes/:id', async (req, res, next) => {
  try {
    const { data, error } = await req.supa.from('quotes').update(snakeize(req.body || {})).eq('id', req.params.id).select().maybeSingle();
    if (error) throw error;
    if (!data) return fail(res, 404, 'not_found');
    ok(res, data);
  } catch (e) { next(e); }
});

api.delete('/quotes/:id', async (req, res, next) => {
  try {
    throwIfError(await req.supa.from('quotes').delete().eq('id', req.params.id));
    res.status(204).end();
  } catch (e) { next(e); }
});

/* ---- Budget ---- */
api.get('/budget/summary', async (req, res, next) => {
  try {
    const { data } = await req.supa.from('projects').select('budget,spent,status');
    const active = (data || []).filter((x) => x.status !== 'termine');
    const budget = active.reduce((s, x) => s + x.budget, 0);
    const spent = active.reduce((s, x) => s + x.spent, 0);
    ok(res, { budget, spent, remaining: budget - spent, burn: budget ? Math.round((spent / budget) * 100) : 0 });
  } catch (e) { next(e); }
});

api.get('/budget/categories', async (req, res, next) => {
  try {
    const { data: cats } = await req.supa.from('cost_categories').select('*');
    let q = req.supa.from('expenses').select('*');
    if (req.query.projectId && req.query.projectId !== 'tous') q = q.eq('project_id', req.query.projectId);
    const { data: expenses } = await q;
    const result = (cats || []).map((c) => ({
      key: c.key, label: c.label, color: c.color,
      amount: (expenses || []).filter((e) => e.category === c.key).reduce((s, e) => s + e.amount, 0)
    })).sort((a, b) => b.amount - a.amount);
    ok(res, result);
  } catch (e) { next(e); }
});

api.get('/budget/projects', async (req, res, next) => {
  try {
    const { data } = await req.supa.from('projects').select('*').neq('status', 'termine');
    ok(res, await Promise.all((data || []).map((p) => decorateProject(req.supa, p))));
  } catch (e) { next(e); }
});

/* ---- Planning ---- */
api.get('/planning', async (req, res, next) => {
  try {
    const t = today();
    if (req.query.projectId && req.query.projectId !== 'tous') {
      const { data: pr } = await req.supa.from('projects').select('id,phases').eq('id', req.query.projectId).maybeSingle();
      if (!pr) return ok(res, []);
      const rows = (pr.phases || []).map((ph, i) => ({
        id: pr.id + '-P' + i, label: ph.name, sub: ph.lead, start: ph.start, end: ph.end, progress: ph.progress,
        status: ph.progress === 100 ? 'termine' : ph.end < t ? 'en_retard' : ph.progress > 0 ? 'en_cours' : 'en_preparation',
        project_id: pr.id
      }));
      return ok(res, rows);
    }
    const { data: list } = await req.supa.from('projects').select('*').neq('status', 'termine');
    const clientIds = [...new Set((list || []).map((p) => p.client_id).filter(Boolean))];
    const { data: clients } = clientIds.length ? await req.supa.from('clients').select('id,company').in('id', clientIds) : { data: [] };
    const nameById = Object.fromEntries((clients || []).map((c) => [c.id, c.company]));
    ok(res, (list || []).map((pr) => ({
      id: pr.id, label: pr.name, sub: nameById[pr.client_id] || '', start: pr.start, end: pr.end,
      progress: pr.progress, status: pr.status, project_id: pr.id
    })));
  } catch (e) { next(e); }
});

/* ---- Reports ---- */
api.get('/reports/attendance', async (req, res, next) => {
  try {
    const t = today();
    const days = [];
    for (let i = 13; i >= 0; i--) {
      const d = dt.add(t, -i);
      if (dt.isWeekend(d)) continue;
      days.push(d);
    }
    const { data: rows } = await req.supa.from('timesheets').select('date,status,hours').in('date', days);
    ok(res, days.map((d) => {
      const dayRows = (rows || []).filter((r) => r.date === d);
      const present = dayRows.filter((r) => r.status !== 'absent');
      return {
        date: d, present: present.length, absent: dayRows.length - present.length,
        hours: Math.round(present.reduce((s, r) => s + Number(r.hours || 0), 0)), planned: dayRows.length * 8
      };
    }));
  } catch (e) { next(e); }
});

api.get('/reports/trades', async (req, res, next) => {
  try {
    const { data: rows } = await req.supa.from('timesheets').select('trade,hours,status').eq('date', today());
    const map = {};
    (rows || []).filter((r) => r.status !== 'absent').forEach((r) => { map[r.trade] = (map[r.trade] || 0) + Number(r.hours || 0); });
    ok(res, Object.entries(map).map(([label, value]) => ({ label, value: Math.round(value) })).sort((a, b) => b.value - a.value));
  } catch (e) { next(e); }
});

/* ---- Notifications ---- */
api.get('/notifications', async (req, res, next) => {
  try {
    const { data, error } = await req.supa.from('notifications').select('*');
    if (error) throw error;
    ok(res, data || []);
  } catch (e) { next(e); }
});

api.patch('/notifications/:id/read', async (req, res, next) => {
  try {
    const { data, error } = await req.supa.from('notifications').update({ read: true }).eq('id', req.params.id).select().maybeSingle();
    if (error) throw error;
    ok(res, data);
  } catch (e) { next(e); }
});

api.post('/notifications/read-all', async (req, res, next) => {
  try {
    throwIfError(await req.supa.from('notifications').update({ read: true }).eq('read', false));
    ok(res, { ok: true });
  } catch (e) { next(e); }
});

/* ---- Search ---- */
api.get('/search', async (req, res, next) => {
  try {
    const q = String(req.query.q || '').toLowerCase().trim();
    if (q.length < 2) return ok(res, []);
    const supa = req.supa;
    const out = [];
    const [{ data: projects }, { data: clients }, { data: workers }, { data: articles }, { data: suppliers }, { data: tasks }] = await Promise.all([
      supa.from('projects').select('id,name,ref,city'),
      supa.from('clients').select('id,company,contact'),
      supa.from('workers').select('id,name,trade'),
      supa.from('articles').select('id,name,ref,category'),
      supa.from('suppliers').select('id,company,contact,specialty,city'),
      supa.from('tasks').select('id,title,assignee')
    ]);
    (projects || []).filter((x) => (x.name + x.ref).toLowerCase().includes(q)).slice(0, 4)
      .forEach((x) => out.push({ group: 'Projets', label: x.name, sub: x.ref + ' · ' + x.city, href: '#/projets/' + x.id, icon: 'building' }));
    (clients || []).filter((x) => (x.company + x.contact).toLowerCase().includes(q)).slice(0, 4)
      .forEach((x) => out.push({ group: 'Clients', label: x.company, sub: x.contact, href: '#/clients/' + x.id, icon: 'users' }));
    (workers || []).filter((x) => x.name.toLowerCase().includes(q)).slice(0, 4)
      .forEach((x) => out.push({ group: 'Ouvriers', label: x.name, sub: x.trade, href: '#/pointage/' + x.id, icon: 'hardhat' }));
    (articles || []).filter((x) => (x.name + x.ref).toLowerCase().includes(q)).slice(0, 4)
      .forEach((x) => out.push({ group: 'Articles', label: x.name, sub: x.ref + ' · ' + x.category, href: '#/articles/' + x.id, icon: 'package' }));
    (suppliers || []).filter((x) => (x.company + x.contact + x.specialty + x.city).toLowerCase().includes(q)).slice(0, 4)
      .forEach((x) => out.push({ group: 'Fournisseurs', label: x.company, sub: x.specialty + ' · ' + x.city, href: '#/fournisseurs/' + x.id, icon: 'truck' }));
    (tasks || []).filter((x) => x.title.toLowerCase().includes(q)).slice(0, 3)
      .forEach((x) => out.push({ group: 'Tâches', label: x.title, sub: x.assignee, href: '#/taches', icon: 'check' }));
    res.json(out);
  } catch (e) { next(e); }
});

/* =========================================================
   Jeu de démonstration par entreprise — un petit jeu de données
   réaliste mais totalement isolé (company_id = l'ingénieur cible),
   pour qu'un admin puisse montrer l'application sans mélanger les
   données d'une entreprise avec celles d'une autre.
   ========================================================= */
async function seedDemoDataForCompany(companyId, companyLabel) {
  const t = today();
  const clientId = await nextId('clients', 'CLI-');
  const client = {
    id: clientId, company_id: companyId, contact: 'Karim Belhassen', company: 'Groupe Belhassen Immobilier',
    city: 'Tunis', phone: '+216 71 200 300', email: 'contact@belhassen-immo.tn', status: 'actif',
    since: t, address: 'Avenue Mohamed V, Tunis'
  };
  throwIfError(await adminClient.from('clients').insert(client));

  const supplierId = await nextId('suppliers', 'FRN-');
  const supplier = {
    id: supplierId, company_id: companyId, company: 'Matériaux du Centre', contact: 'Sana Jebali',
    phone: '+216 73 400 500', email: 'ventes@materiaux-centre.tn', address: 'Zone industrielle, Sousse',
    city: 'Sousse', specialty: 'Matériaux généraux', lead_days: 3, rating: 4.2, tax_id: '1300000/A/M/000',
    payment: '30 jours fin de mois', since: t, status: 'actif', featured: [], note: ''
  };
  throwIfError(await adminClient.from('suppliers').insert(supplier));

  const ARTICLE_DEFS = [
    ['Ciment CEM II 25 kg', 'Gros œuvre', 'sac', 150, 100, 12.5],
    ['Sable de carrière', 'Gros œuvre', 'm³', 40, 20, 38],
    ['Fer à béton Ø10', 'Ferraillage', 'barre', 120, 80, 19.6],
    ['Câble 3G2,5 (couronne 100 m)', 'Électricité', 'couronne', 15, 10, 186],
    ['Tube PVC Ø50 (4 m)', 'Plomberie', 'barre', 60, 30, 17.5],
    ['Peinture acrylique blanche 20 L', 'Finition', 'seau', 20, 12, 128]
  ];
  const articleIds = await nextIds('articles', 'ART-', ARTICLE_DEFS.length);
  const articles = ARTICLE_DEFS.map(([name, category, unit, stock, min, price], i) => {
    const id = articleIds[i];
    return {
      id, company_id: companyId, ref: 'MAT-' + id.slice(4), name, category, unit, stock, min, price,
      supplier: supplier.company, supplier_id: supplierId, location: 'Dépôt central', last_entry: t,
      stock_status: stock === 0 ? 'rupture' : stock < min ? 'faible' : 'ok'
    };
  });
  throwIfError(await adminClient.from('articles').insert(articles));

  const WORKER_DEFS = [
    ['Sami Ferjani', 'Chef d\'équipe', 22], ['Mounir Ayari', 'Maçon', 16],
    ['Rania Ghariani', 'Électricienne', 19], ['Bilel Souissi', 'Plombier', 19],
    ['Wael Nasri', 'Manœuvre', 12]
  ];
  const workerIds = await nextIds('workers', 'OUV-', WORKER_DEFS.length);
  const workers = WORKER_DEFS.map(([name, trade, rate], i) => ({
    id: workerIds[i], company_id: companyId, matricule: 'M' + (2000 + i), name, trade, rate,
    cnss: 'CNSS-' + (90000 + i * 17), since: t, contract: 'Journalier', status: 'actif'
  }));
  throwIfError(await adminClient.from('workers').insert(workers));

  const PROJECT_DEFS = [
    { name: 'Résidence ' + (companyLabel || 'Le Jardin'), city: 'Tunis', budget: 180000, progress: 35, status: 'en_cours' },
    { name: 'Villa Les Oliviers', city: 'Sousse', budget: 95000, progress: 8, status: 'en_preparation' }
  ];
  const TASK_DEFS = ['Installation de chantier', 'Fondations et semelles', 'Maçonnerie et cloisons'];
  for (const [i, pd] of PROJECT_DEFS.entries()) {
    const pid = await nextId('projects', 'PRJ-');
    workers[i % workers.length].project_id = pid;
    workers[(i + 1) % workers.length].project_id = pid;
    const phases = [];
    const taskRows = [];
    let start = dt.add(t, -20 + i * 5);
    const taskIds = await nextIds('tasks', 'TSK-', TASK_DEFS.length);
    for (const [ti, title] of TASK_DEFS.entries()) {
      const tid = taskIds[ti];
      const due = dt.add(start, 12);
      const progress = pd.status === 'en_preparation' ? 0 : Math.max(0, 100 - (TASK_DEFS.indexOf(title) * 35));
      phases.push({ taskId: tid, name: title, start, end: due, progress, lead: workers[i % workers.length].name });
      taskRows.push({
        id: tid, project_id: pid, title, assignee: workers[i % workers.length].name, priority: 'moyenne',
        start, due, progress, status: progress === 100 ? 'termine' : progress > 0 ? 'en_cours' : 'a_faire', created_at: t
      });
      start = dt.add(due, 1);
    }
    throwIfError(await adminClient.from('projects').insert({
      id: pid, company_id: companyId, created_by: companyId, ref: 'CHT-' + t.slice(0, 4) + '-' + pid.slice(4),
      name: pd.name, client_id: clientId, address: pd.city, city: pd.city, manager: workers[i % workers.length].name,
      start: dt.add(t, -25), end: dt.add(t, 150), status: pd.status, progress: pd.progress,
      budget: pd.budget, spent: Math.round(pd.budget * pd.progress / 100), type: 'Projet de démonstration',
      phases
    }));
    throwIfError(await adminClient.from('project_members').upsert({ project_id: pid, user_id: companyId }));
    if (taskRows.length) throwIfError(await adminClient.from('tasks').insert(taskRows));

    const matId = 'AFF-' + pid + '-01';
    throwIfError(await adminClient.from('project_materials').insert({
      id: matId, project_id: pid, article_id: articles[i % articles.length].id, qty: 20, date: t,
      note: 'Dotation initiale', author: companyLabel || 'Chef de projet'
    }));
  }
  throwIfError(await adminClient.from('workers').upsert(workers));

  throwIfError(await adminClient.from('activity').insert([
    { company_id: companyId, icon: 'building', tone: 'info', title: 'Chantier ouvert — ' + PROJECT_DEFS[0].name, meta: client.company, time: t }
  ]));
}

/* =========================================================
   Admin — gestion des utilisateurs (clé service role)
   ========================================================= */
const admin = express.Router();
admin.use(requireAuth, requireAdmin);

admin.get('/users', async (req, res, next) => {
  try {
    const { data: profiles, error } = await adminClient.from('profiles').select('*');
    if (error) throw error;
    const { data: memberships } = await adminClient.from('project_members').select('*');
    const projectsByUser = {};
    (memberships || []).forEach((m) => {
      (projectsByUser[m.user_id] = projectsByUser[m.user_id] || []).push(m.project_id);
    });
    ok(res, (profiles || []).map((p) => ({ ...p, project_ids: projectsByUser[p.id] || [] })));
  } catch (e) { next(e); }
});

// Invites a new company (ingénieur, the default) or, with role:'assistant'
// + companyId, an assistant under an existing company — admin can manage
// both from the same "Entreprises" screen.
admin.post('/users/invite', async (req, res, next) => {
  try {
    const { email, fullName, projectIds, role, companyId } = req.body || {};
    if (!email) return fail(res, 400, 'email_required');
    if (!isAllowedDomain(email)) return fail(res, 400, `Utilisez une adresse e-mail @${ALLOWED_SIGNUP_DOMAIN}.`);
    if (role === 'assistant' && !companyId) return fail(res, 400, 'companyId_required');
    const { data, error } = await adminClient.auth.admin.inviteUserByEmail(email, {
      data: { full_name: fullName || '' }
    });
    if (error) throw error;
    const userId = data.user.id;
    const patch = {};
    if (fullName) patch.full_name = fullName;
    if (role === 'assistant') { patch.role = 'assistant'; patch.company_id = companyId; }
    if (Object.keys(patch).length) await adminClient.from('profiles').update(patch).eq('id', userId);
    if (role !== 'assistant' && Array.isArray(projectIds) && projectIds.length) {
      throwIfError(await adminClient.from('project_members').insert(projectIds.map((pid) => ({ project_id: pid, user_id: userId }))));
    }
    ok(res, { id: userId, email }, 201);
  } catch (e) { next(e); }
});

admin.patch('/users/:id', async (req, res, next) => {
  try {
    const patch = snakeize(req.body || {});
    delete patch.id;
    const { data, error } = await adminClient.from('profiles').update(patch).eq('id', req.params.id).select().maybeSingle();
    if (error) throw error;
    if (!data) return fail(res, 404, 'not_found');
    ok(res, data);
  } catch (e) { next(e); }
});

admin.post('/users/:id/projects', async (req, res, next) => {
  try {
    const { projectIds } = req.body || {};
    throwIfError(await adminClient.from('project_members').delete().eq('user_id', req.params.id));
    if (Array.isArray(projectIds) && projectIds.length) {
      throwIfError(await adminClient.from('project_members').insert(projectIds.map((pid) => ({ project_id: pid, user_id: req.params.id }))));
    }
    ok(res, { ok: true });
  } catch (e) { next(e); }
});

admin.post('/users/:id/demo-seed', async (req, res, next) => {
  try {
    const { data: profile } = await adminClient.from('profiles').select('role,full_name').eq('id', req.params.id).maybeSingle();
    if (!profile) return fail(res, 404, 'not_found');
    if (profile.role !== 'ingenieur') return fail(res, 400, 'seed_target_must_be_ingenieur');
    const { count } = await adminClient.from('projects').select('id', { count: 'exact', head: true }).eq('company_id', req.params.id);
    if (count > 0) return fail(res, 400, 'company_already_has_data');
    await seedDemoDataForCompany(req.params.id, profile.full_name);
    ok(res, { ok: true }, 201);
  } catch (e) { next(e); }
});

api.use('/admin', admin);

/* ---- Assistants — gérés par l'ingénieur lui-même (ou par l'admin via
   /admin/users/invite avec role:'assistant'). Toujours via le client
   service role : un ingénieur n'a pas le privilège auth.admin, donc le
   serveur agit en son nom une fois son rôle vérifié. ---- */
api.get('/assistants', requireIngenieur, async (req, res, next) => {
  try {
    const { data, error } = await adminClient.from('profiles').select('*').eq('company_id', req.userId).eq('role', 'assistant');
    if (error) throw error;
    ok(res, data || []);
  } catch (e) { next(e); }
});

api.post('/assistants/invite', requireIngenieur, async (req, res, next) => {
  try {
    const { email, fullName } = req.body || {};
    if (!email) return fail(res, 400, 'email_required');
    if (!isAllowedDomain(email)) return fail(res, 400, `Utilisez une adresse e-mail @${ALLOWED_SIGNUP_DOMAIN}.`);
    const { data, error } = await adminClient.auth.admin.inviteUserByEmail(email, {
      data: { full_name: fullName || '' }
    });
    if (error) throw error;
    const patch = { role: 'assistant', company_id: req.userId };
    if (fullName) patch.full_name = fullName;
    await adminClient.from('profiles').update(patch).eq('id', data.user.id);
    ok(res, { id: data.user.id, email }, 201);
  } catch (e) { next(e); }
});

api.patch('/assistants/:id', requireIngenieur, async (req, res, next) => {
  try {
    const { data: target } = await adminClient.from('profiles').select('company_id,role').eq('id', req.params.id).maybeSingle();
    if (!target || target.role !== 'assistant' || target.company_id !== req.userId) return fail(res, 404, 'not_found');
    const patch = snakeize(req.body || {});
    delete patch.id; delete patch.role; delete patch.company_id; delete patch.email;
    const { data, error } = await adminClient.from('profiles').update(patch).eq('id', req.params.id).select().maybeSingle();
    if (error) throw error;
    ok(res, data);
  } catch (e) { next(e); }
});

/* ---- Racine ---- */
api.get('/', (req, res) => {
  res.json({ name: 'BâtiPilot API', version: 'v1', today: today(), mode: 'supabase' });
});

app.use('/api/v1', api);

/* ---- Gestion d'erreurs ---- */
app.use((err, req, res, next) => {
  console.error(err);
  // Postgres 42501 / PostgREST's RLS-violation message means the request
  // was correctly blocked by a policy — that's a permissions problem
  // (403), not a server fault (500).
  const isRlsBlock = err.code === '42501' || /row-level security policy/i.test(err.message || '');
  if (isRlsBlock) return res.status(403).json({ error: 'forbidden' });
  // A handler can throw an Error with a `status` (e.g. assertNoTimeOverlap's
  // 409) to surface a specific, user-facing message instead of the generic
  // 500 — the message is meant to reach the toast the user sees.
  res.status(err.status || 500).json({ error: err.message || 'server_error' });
});

module.exports = app;
