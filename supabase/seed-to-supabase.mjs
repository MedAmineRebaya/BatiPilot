#!/usr/bin/env node
/* =========================================================
   BâtiPilot — Charge db_seed.json dans Supabase
   ---------------------------------------------------------
   Usage (une seule fois, après avoir exécuté schema.sql) :
     SUPABASE_URL=https://xxxx.supabase.co \
     SUPABASE_SERVICE_ROLE_KEY=eyJ... \
     node supabase/seed-to-supabase.mjs
   Ou avec un fichier .env à la racine (voir .env.example).
   ========================================================= */
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import 'dotenv/config';

const __dirname = dirname(fileURLToPath(import.meta.url));

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY doivent être définis (voir .env.example).');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false }
});

const db = JSON.parse(readFileSync(join(__dirname, '..', 'db_seed.json'), 'utf8'));

async function upsert(table, rows, label = table) {
  if (!rows.length) {
    console.log(`  ${label}: 0 lignes (rien à faire)`);
    return;
  }
  const { error } = await supabase.from(table).upsert(rows, { onConflict: rows[0].id !== undefined ? 'id' : undefined });
  if (error) throw new Error(`${label}: ${error.message}`);
  console.log(`  ${label}: ${rows.length} lignes`);
}

async function main() {
  console.log('Chargement de db_seed.json vers Supabase…\n');

  await upsert('cost_categories', (db.costCategories || []).map(c => ({
    key: c.key, label: c.label, share: c.share, color: c.color
  })));

  await upsert('suppliers', (db.suppliers || []).map(s => ({
    id: s.id, company: s.company, contact: s.contact, phone: s.phone, email: s.email,
    address: s.address, city: s.city, specialty: s.specialty, lead_days: s.leadDays,
    rating: s.rating, tax_id: s.taxId, payment: s.payment, since: s.since,
    status: s.status, featured: s.featured || [], note: s.note || ''
  })));

  await upsert('clients', (db.clients || []).map(c => ({
    id: c.id, contact: c.contact, company: c.company, city: c.city,
    phone: c.phone, email: c.email, status: c.status, since: c.since, address: c.address
  })));

  await upsert('articles', (db.articles || []).map(a => ({
    id: a.id, ref: a.ref, name: a.name, category: a.category, unit: a.unit,
    stock: a.stock, min: a.min, price: a.price, supplier: a.supplier,
    supplier_id: a.supplierId || null, location: a.location,
    last_entry: a.lastEntry || null, stock_status: a.stockStatus
  })));

  // projects go in without phases[].taskId cross-refs breaking anything — phases stay as jsonb
  await upsert('projects', (db.projects || []).map(p => ({
    id: p.id, ref: p.ref, name: p.name, client_id: p.clientId || null,
    address: p.address, city: p.city, manager: p.manager,
    start: p.start || null, end: p.end || null, status: p.status,
    progress: p.progress, budget: p.budget, spent: p.spent, type: p.type,
    phases: p.phases || []
  })));

  await upsert('workers', (db.workers || []).map(w => ({
    id: w.id, matricule: w.matricule, name: w.name, trade: w.trade,
    project_id: w.projectId || null, phone: w.phone, rate: w.rate, cnss: w.cnss,
    since: w.since, contract: w.contract, status: w.status || 'actif'
  })));

  await upsert('tasks', (db.tasks || []).map(t => ({
    id: t.id, title: t.title, project_id: t.projectId || null, assignee: t.assignee,
    priority: t.priority, start: t.start || null, due: t.due || null,
    progress: t.progress, status: t.status, created_at: t.createdAt || null
  })));

  await upsert('project_materials', (db.projectMaterials || []).map(m => ({
    id: m.id, project_id: m.projectId || null, article_id: m.articleId,
    qty: m.qty, date: m.date, note: m.note || '', author: m.author || ''
  })));

  const timesheetRows = [];
  Object.values(db.timesheetsByDate || {}).forEach(rows => {
    rows.forEach(r => timesheetRows.push({
      id: r.id, date: r.date, worker_id: r.workerId, worker: r.worker, trade: r.trade,
      project_id: r.projectId || null, in: r.in, out: r.out, break_min: r.breakMin || 0,
      hours: r.hours, status: r.status, note: r.note || ''
    }));
  });
  await upsert('timesheets', timesheetRows);

  await upsert('task_catalog', (db.taskCatalog || []).map(c => ({
    id: c.id, name: c.name, category: c.category, default_days: c.defaultDays,
    trade: c.trade, active: c.active
  })));

  const attachmentRows = [];
  Object.entries(db.attachments || {}).forEach(([projectId, list]) => {
    list.forEach(a => attachmentRows.push({
      id: a.id, project_id: projectId, name: a.name, kind: a.kind,
      size: a.size, date: a.date, author: a.author
    }));
  });
  await upsert('attachments', attachmentRows);

  await upsert('quotes', (db.quotes || []).map(q => ({
    id: q.id, client_id: q.clientId || null, title: q.title, date: q.date,
    status: q.status, project_id: q.projectId || null, lines: q.lines || [], total: q.total
  })));

  await upsert('expenses', (db.expenses || []).map(e => ({
    id: e.id, project_id: e.projectId || null, category: e.category,
    label: e.label, amount: e.amount
  })));

  await upsert('notifications', (db.notifications || []).map(n => ({
    id: n.id, project_id: null, level: n.level, title: n.title, text: n.text,
    time: n.time, link: n.link, read: n.read
  })));

  await upsert('activity', (db.activity || []).map(a => ({
    project_id: null, icon: a.icon, tone: a.tone, title: a.title, meta: a.meta, time: a.time
  })));

  console.log('\nTerminé.');
}

main().catch(err => {
  console.error('\nÉchec du chargement :', err.message);
  process.exit(1);
});
