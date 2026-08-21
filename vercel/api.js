/* =========================================================
   BâtiPilot — Couche d'accès aux données
   ---------------------------------------------------------
   Toutes les pages passent par ERP.Api et n'accèdent JAMAIS
   directement à ERP.DB. Pour brancher un vrai backend :
       ERP.Api.config.mode    = 'http';
       ERP.Api.config.baseUrl = 'https://api.monerp.tn/v1';
       ERP.Api.config.token   = '<jwt>';
   Les signatures des méthodes ne changent pas.
   ========================================================= */
window.ERP = window.ERP || {};

(function (ERP) {
  'use strict';

  const DB = ERP.DB;
  const dt = ERP.dt;

  const config = {
    mode: 'mock',                 // 'mock' | 'http' — mock = localStorage
    baseUrl: '/api/v1',
    token: null,
    latency: 90                   // simule le réseau : ressenti réaliste
  };

  /** Force le stockage navigateur (ignore le serveur JSON). */
  function useLocalStorage() {
    config.mode = 'mock';
    config.token = null;
    try { localStorage.removeItem('batipilot-api'); } catch (_) {}
  }

  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const clone = (v) => JSON.parse(JSON.stringify(v));

  /** Persiste l'état courant dans localStorage (démo / tests). */
  function persist() {
    if (ERP.DB && typeof ERP.DB.save === 'function') ERP.DB.save();
  }

  /* --- Point d'entrée unique : à remplacer par fetch() côté HTTP --- */
  async function request(resource, { method = 'GET', params = null, body = null } = {}) {
    if (config.mode === 'http') {
      // baseUrl absolue (http://localhost:3001/api/v1) ou relative
      const base = config.baseUrl.replace(/\/$/, '');
      let url;
      if (/^https?:\/\//i.test(base)) {
        url = new URL(base + resource);
      } else {
        url = new URL(base + resource, location.origin);
      }
      if (params) Object.entries(params).forEach(([k, v]) => v != null && url.searchParams.set(k, v));
      const res = await fetch(url.toString(), {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(config.token ? { Authorization: 'Bearer ' + config.token } : {})
        },
        body: body ? JSON.stringify(body) : undefined
      });
      if (!res.ok) {
        let detail = res.statusText;
        try { const j = await res.json(); if (j && j.error) detail = j.error; } catch (_) {}
        throw new Error(`${res.status} ${detail}`);
      }
      if (res.status === 204) return null;
      const ct = res.headers.get('content-type') || '';
      return ct.includes('json') ? res.json() : null;
    }
    await wait(config.latency);
    return mock(resource, method, params, body);
  }

  /* =======================================================
     Sélecteurs / calculs métier
     ======================================================= */
  const byId = (arr, id) => arr.find(x => x.id === id) || null;

  const isLate = (t) => t.status !== 'termine' && t.due < DB.today;

  function decorateProject(p) {
    const client = byId(DB.clients, p.clientId);
    const team = DB.workers.filter(w => w.projectId === p.id);
    const ts = DB.timesheets(DB.today).filter(t => t.projectId === p.id);
    const present = ts.filter(t => t.status !== 'absent');
    const pTasks = DB.tasks.filter(t => t.projectId === p.id);
    const late = p.phases.filter(ph => ph.progress < 100 && ph.end < DB.today);
    const daysLate = late.length ? Math.max(...late.map(ph => dt.diff(ph.end, DB.today))) : 0;
    return Object.assign({}, p, {
      clientName: client ? client.company : '—',
      clientContact: client ? client.contact : '—',
      teamSize: team.length,
      presentToday: present.length,
      hoursToday: present.reduce((s, t) => s + t.hours, 0),
      remaining: p.budget - p.spent,
      burn: p.budget ? Math.round(p.spent / p.budget * 100) : 0,
      tasksTotal: pTasks.length,
      tasksLate: pTasks.filter(isLate).length,
      tasksDone: pTasks.filter(t => t.status === 'termine').length,
      daysLate,
      latePhases: late.map(ph => ph.name),
      materialsCount: DB.projectMaterials.filter(m => m.projectId === p.id).length,
      materialsCost: DB.projectMaterials.filter(m => m.projectId === p.id)
        .reduce((s, m) => { const a = byId(DB.articles, m.articleId); return s + (a ? m.qty * a.price : 0); }, 0)
    });
  }

  /** Une affectation enrichie des informations de l'article (libellé, unité, prix, stock). */
  function decorateMaterial(m) {
    const a = byId(DB.articles, m.articleId);
    const p = byId(DB.projects, m.projectId);
    return Object.assign({}, m, {
      name: a ? a.name : '—', ref: a ? a.ref : '—', unit: a ? a.unit : '',
      category: a ? a.category : '—', price: a ? a.price : 0,
      total: a ? m.qty * a.price : 0,
      stock: a ? a.stock : 0, min: a ? a.min : 0,
      stockStatus: a ? a.stockStatus : 'ok',
      supplier: a ? a.supplier : '—',
      projectName: p ? p.name : '—'
    });
  }

  /** Mouvement de stock : met à jour la quantité et recalcule le statut. */
  function moveStock(article, delta) {
    article.stock = Math.max(0, article.stock + delta);
    article.stockStatus = article.stock === 0 ? 'rupture'
      : (article.stock < article.min ? 'faible' : 'ok');
    if (delta > 0) article.lastEntry = DB.today;
  }

  /** Impute (ou décharge) un montant sur le poste Matériaux du chantier. */
  function chargeProject(projectId, amount) {
    const p = byId(DB.projects, projectId);
    if (!p) return;
    p.spent = Math.max(0, Math.round(p.spent + amount));
    const key = `DEP-${projectId}-materiaux`;
    const line = DB.expenses.find(e => e.id === key);
    if (line) line.amount = Math.max(0, Math.round(line.amount + amount));
    else DB.expenses.push({
      id: key, projectId, category: 'materiaux', label: 'Matériaux',
      amount: Math.max(0, Math.round(amount))
    });
  }

  /** Un fournisseur enrichi de son activité : références, alertes, achats. */
  function decorateSupplier(s) {
    const arts = DB.articles.filter(a => a.supplierId === s.id);
    const moves = DB.projectMaterials.filter(m => {
      const a = byId(DB.articles, m.articleId);
      return a && a.supplierId === s.id;
    });
    const purchases = moves.reduce((sum, m) => {
      const a = byId(DB.articles, m.articleId);
      return sum + (a ? m.qty * a.price : 0);
    }, 0);
    const lastMove = moves.length ? moves.slice().sort((x, y) => y.date.localeCompare(x.date))[0].date : null;
    return Object.assign({}, s, {
      articleCount: arts.length,
      featuredCount: s.featured.length,
      alerts: arts.filter(a => a.stockStatus !== 'ok').length,
      ruptures: arts.filter(a => a.stockStatus === 'rupture').length,
      stockValue: arts.reduce((sum, a) => sum + a.stock * a.price, 0),
      purchases,
      lastMove,
      projectCount: new Set(moves.map(m => m.projectId)).size
    });
  }

  function decorateClient(c) {
    const ps = DB.projects.filter(p => p.clientId === c.id);
    return Object.assign({}, c, {
      projectCount: ps.length,
      totalAmount: ps.reduce((s, p) => s + p.budget, 0),
      openCount: ps.filter(p => p.status !== 'termine').length,
      lastProject: ps.length ? ps.slice().sort((a, b) => b.start.localeCompare(a.start))[0].name : '—'
    });
  }

  function decorateWorker(w) {
    const p = byId(DB.projects, w.projectId);
    const entry = DB.timesheets(DB.today).find(t => t.workerId === w.id) || null;
    // 30 derniers jours ouvrés simulés pour la fiche ouvrier
    let month = 0;
    for (let i = 0; i < 30; i++) {
      const d = dt.add(DB.today, -i);
      if (dt.isWeekend(d)) continue;
      const e = DB.timesheets(d).find(t => t.workerId === w.id);
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

  /* =======================================================
     Adaptateur « mock »
     ======================================================= */
  function mock(resource, method, params, body) {
    const p = params || {};

    /* ---- Tableau de bord ---- */
    if (resource === '/dashboard/kpis') {
      const active = DB.projects.filter(x => x.status !== 'termine');
      const done = DB.projects.filter(x => x.status === 'termine');
      const ts = DB.timesheets(DB.today);
      const present = ts.filter(t => t.status !== 'absent');
      const budget = active.reduce((s, x) => s + x.budget, 0);
      const spent = active.reduce((s, x) => s + x.spent, 0);
      return {
        activeProjects: active.length,
        doneProjects: done.length,
        scheduled: ts.length,
        present: present.length,
        absent: ts.length - present.length,
        hoursToday: present.reduce((s, t) => s + t.hours, 0),
        lateTasks: DB.tasks.filter(isLate).length,
        lateProjects: active.filter(x => x.status === 'en_retard').length,
        budget, spent, remaining: budget - spent,
        burn: Math.round(spent / budget * 100)
      };
    }
    if (resource === '/dashboard/activity') return clone(DB.activity);

    /* ---- Projets ---- */
    if (resource === '/projects') {
      let list = DB.projects.map(decorateProject);
      if (p.status && p.status !== 'tous') list = list.filter(x => x.status === p.status);
      if (p.q) {
        const q = p.q.toLowerCase();
        list = list.filter(x => (x.name + x.clientName + x.city + x.address + x.ref).toLowerCase().includes(q));
      }
      return list;
    }
    if (resource.startsWith('/projects/')) {
      const found = byId(DB.projects, resource.split('/')[2]);
      return found ? decorateProject(found) : null;
    }

    /* ---- Clients ---- */
    if (resource === '/clients') {
      let list = DB.clients.map(decorateClient);
      if (p.status && p.status !== 'tous') list = list.filter(x => x.status === p.status);
      if (p.q) {
        const q = p.q.toLowerCase();
        list = list.filter(x => (x.company + x.contact + x.city + x.email).toLowerCase().includes(q));
      }
      return list;
    }
    if (resource.startsWith('/clients/')) {
      const id = resource.split('/')[2];
      const c = byId(DB.clients, id);
      if (!c) return null;
      return Object.assign(decorateClient(c), {
        projects: DB.projects.filter(x => x.clientId === id).map(decorateProject),
        quotes: DB.quotes.filter(q => q.clientId === id),
        history: DB.quotes.filter(q => q.clientId === id).map(q => ({
          type: 'Devis', tone: q.status === 'accepte' ? 'ok' : 'info', ref: q.id,
          date: q.date, amount: q.total, quoteId: q.id,
          note: q.title + (q.projectId ? ' — converti en projet' : '')
        })).concat(DB.clientHistory(id))
          .sort((a, b) => b.date.localeCompare(a.date))
      });
    }

    /* ---- Ouvriers ---- */
    if (resource === '/workers') {
      let list = DB.workers.map(decorateWorker);
      if (p.projectId && p.projectId !== 'tous') list = list.filter(x => x.projectId === p.projectId);
      if (p.trade && p.trade !== 'tous') list = list.filter(x => x.trade === p.trade);
      if (p.q) {
        const q = p.q.toLowerCase();
        list = list.filter(x => (x.name + x.trade + x.matricule).toLowerCase().includes(q));
      }
      return list;
    }
    if (resource.startsWith('/workers/')) {
      const w = byId(DB.workers, resource.split('/')[2]);
      return w ? decorateWorker(w) : null;
    }

    /* ---- Pointage ---- */
    if (resource === '/timesheets') {
      const date = p.date || DB.today;
      let rows = DB.timesheets(date).map(r => Object.assign({}, r, {
        projectName: (byId(DB.projects, r.projectId) || {}).name || '—'
      }));
      if (p.projectId && p.projectId !== 'tous') rows = rows.filter(r => r.projectId === p.projectId);
      if (p.trade && p.trade !== 'tous') rows = rows.filter(r => r.trade === p.trade);
      if (p.status && p.status !== 'tous') rows = rows.filter(r => r.status === p.status);
      if (p.q) rows = rows.filter(r => r.worker.toLowerCase().includes(p.q.toLowerCase()));
      return rows;
    }
    if (resource === '/timesheets/summary') {
      const rows = DB.timesheets(p.date || DB.today);
      const present = rows.filter(r => r.status !== 'absent');
      return {
        date: p.date || DB.today,
        scheduled: rows.length,
        present: present.length,
        absent: rows.filter(r => r.status === 'absent').length,
        late: rows.filter(r => r.status === 'retard').length,
        hours: present.reduce((s, r) => s + r.hours, 0),
        cost: Math.round(present.reduce((s, r) => {
          const w = byId(DB.workers, r.workerId);
          return s + r.hours * (w ? w.rate : 15);
        }, 0))
      };
    }
    if (resource === '/timesheets' && method === 'POST') return body;

    /* ---- Articles ---- */
    if (resource === '/articles') {
      let list = clone(DB.articles);
      if (p.category && p.category !== 'tous') list = list.filter(a => a.category === p.category);
      if (p.stockStatus && p.stockStatus !== 'tous') list = list.filter(a => a.stockStatus === p.stockStatus);
      if (p.q) {
        const q = p.q.toLowerCase();
        list = list.filter(a => (a.name + a.ref + a.supplier + a.category).toLowerCase().includes(q));
      }
      return list;
    }
    if (resource.startsWith('/articles/')) return clone(byId(DB.articles, resource.split('/')[2]));

    /* ---- Tâches ---- */
    if (resource === '/tasks') {
      let list = DB.tasks.map(t => Object.assign({}, t, {
        projectName: (byId(DB.projects, t.projectId) || {}).name || '—',
        late: isLate(t)
      }));
      if (p.projectId && p.projectId !== 'tous') list = list.filter(t => t.projectId === p.projectId);
      if (p.status && p.status !== 'tous') list = list.filter(t => t.status === p.status);
      if (p.priority && p.priority !== 'tous') list = list.filter(t => t.priority === p.priority);
      if (p.q) list = list.filter(t => (t.title + t.assignee).toLowerCase().includes(p.q.toLowerCase()));
      return list;
    }

    /* ---- Budget ---- */
    if (resource === '/budget/summary') {
      const active = DB.projects.filter(x => x.status !== 'termine');
      const budget = active.reduce((s, x) => s + x.budget, 0);
      const spent = active.reduce((s, x) => s + x.spent, 0);
      return { budget, spent, remaining: budget - spent, burn: Math.round(spent / budget * 100) };
    }
    if (resource === '/budget/categories') {
      return DB.costCategories.map(c => ({
        key: c.key, label: c.label, color: c.color,
        amount: DB.expenses.filter(e => e.category === c.key && (!p.projectId || p.projectId === 'tous' || e.projectId === p.projectId))
          .reduce((s, e) => s + e.amount, 0)
      })).sort((a, b) => b.amount - a.amount);
    }
    if (resource === '/budget/projects') {
      return DB.projects.filter(x => x.status !== 'termine').map(decorateProject);
    }

    /* ---- Planning ---- */
    if (resource === '/planning') {
      const list = DB.projects.filter(x => x.status !== 'termine');
      if (p.projectId && p.projectId !== 'tous') {
        const pr = byId(DB.projects, p.projectId);
        if (!pr) return [];
        return pr.phases.map((ph, i) => ({
          id: pr.id + '-P' + i, label: ph.name, sub: ph.lead,
          start: ph.start, end: ph.end, progress: ph.progress,
          status: ph.progress === 100 ? 'termine' : (ph.end < DB.today ? 'en_retard' : (ph.progress > 0 ? 'en_cours' : 'en_preparation')),
          projectId: pr.id
        }));
      }
      return list.map(pr => ({
        id: pr.id, label: pr.name, sub: (byId(DB.clients, pr.clientId) || {}).company || '',
        start: pr.start, end: pr.end, progress: pr.progress, status: pr.status, projectId: pr.id
      }));
    }

    /* ---- Rapports ---- */
    if (resource === '/reports/attendance') {
      const days = [];
      for (let i = 13; i >= 0; i--) {
        const d = dt.add(DB.today, -i);
        if (dt.isWeekend(d)) continue;
        const rows = DB.timesheets(d);
        const present = rows.filter(r => r.status !== 'absent');
        days.push({
          date: d,
          present: present.length,
          absent: rows.length - present.length,
          hours: Math.round(present.reduce((s, r) => s + r.hours, 0)),
          planned: rows.length * 8
        });
      }
      return days;
    }
    if (resource === '/reports/trades') {
      const rows = DB.timesheets(DB.today).filter(r => r.status !== 'absent');
      const map = {};
      rows.forEach(r => { map[r.trade] = (map[r.trade] || 0) + r.hours; });
      return Object.entries(map).map(([label, value]) => ({ label, value: Math.round(value) }))
        .sort((a, b) => b.value - a.value);
    }

    /* ---- Notifications ---- */
    if (resource === '/notifications') return clone(DB.notifications);

    /* ---- Recherche globale ---- */
    if (resource === '/search') {
      const q = (p.q || '').toLowerCase().trim();
      if (q.length < 2) return [];
      const out = [];
      DB.projects.filter(x => (x.name + x.ref).toLowerCase().includes(q)).slice(0, 4)
        .forEach(x => out.push({ group: 'Projets', label: x.name, sub: x.ref + ' · ' + x.city, href: '#/projets/' + x.id, icon: 'building' }));
      DB.clients.filter(x => (x.company + x.contact).toLowerCase().includes(q)).slice(0, 4)
        .forEach(x => out.push({ group: 'Clients', label: x.company, sub: x.contact, href: '#/clients/' + x.id, icon: 'users' }));
      DB.workers.filter(x => x.name.toLowerCase().includes(q)).slice(0, 4)
        .forEach(x => out.push({ group: 'Ouvriers', label: x.name, sub: x.trade, href: '#/pointage/' + x.id, icon: 'hardhat' }));
      DB.articles.filter(x => (x.name + x.ref).toLowerCase().includes(q)).slice(0, 4)
        .forEach(x => out.push({ group: 'Articles', label: x.name, sub: x.ref + ' · ' + x.category, href: '#/articles/' + x.id, icon: 'package' }));
      DB.suppliers.filter(x => (x.company + x.contact + x.specialty + x.city).toLowerCase().includes(q)).slice(0, 4)
        .forEach(x => out.push({ group: 'Fournisseurs', label: x.company, sub: x.specialty + ' · ' + x.city, href: '#/fournisseurs/' + x.id, icon: 'truck' }));
      DB.tasks.filter(x => x.title.toLowerCase().includes(q)).slice(0, 3)
        .forEach(x => out.push({ group: 'Tâches', label: x.title, sub: x.assignee, href: '#/taches', icon: 'check' }));
      return out;
    }

    throw new Error('Ressource inconnue : ' + resource);
  }

  /* =======================================================
     API publique
     ======================================================= */
  ERP.Api = {
    config,
    request,
    useLocalStorage,

    dashboard: {
      kpis: () => request('/dashboard/kpis'),
      activity: () => request('/dashboard/activity')
    },
    projects: {
      list: (params) => request('/projects', { params }),
      get: (id) => request('/projects/' + id),
      create: (p) => {
        if (config.mode === 'http') return request('/projects', { method: 'POST', body: p });
        const n = ERP.DB.projects.length + 1;
        const picked = p.tasks || [];
        const item = Object.assign({
          id: 'PRJ-' + String(n).padStart(3, '0'),
          ref: 'CHT-' + ERP.DB.today.slice(0, 4) + '-' + String(n).padStart(3, '0'),
          spent: 0, progress: 0, status: 'en_preparation'
        }, p);
        delete item.tasks;

        // Chaque tâche choisie devient une tâche du chantier ET un lot du planning
        item.phases = picked.map((t, i) => {
          const taskId = 'TSK-' + String(ERP.DB.tasks.length + i + 1).padStart(3, '0');
          return { taskId, name: t.name, start: t.start, end: t.end, progress: 0, lead: t.assignee || item.manager };
        });
        ERP.DB.projects.unshift(item);
        picked.forEach((t, i) => {
          ERP.DB.tasks.push({
            id: item.phases[i].taskId, title: t.name, projectId: item.id,
            assignee: t.assignee || item.manager, priority: t.priority || 'moyenne',
            start: t.start, due: t.end, progress: 0, status: 'a_faire', createdAt: ERP.DB.today
          });
        });
        persist();
        return Promise.resolve(item);
      },
      update: (id, patch) => {
        if (config.mode === 'http') return request('/projects/' + id, { method: 'PATCH', body: patch });
        const p = ERP.DB.projects.find(x => x.id === id);
        if (p) Object.assign(p, patch);
        persist();
        return Promise.resolve(p);
      },
      remove: (id) => {
        if (config.mode === 'http') return request('/projects/' + id, { method: 'DELETE' });
        const i = ERP.DB.projects.findIndex(x => x.id === id);
        if (i > -1) ERP.DB.projects.splice(i, 1);
        ERP.DB.tasks = ERP.DB.tasks.filter(t => t.projectId !== id);
        ERP.DB.projectMaterials = ERP.DB.projectMaterials.filter(m => m.projectId !== id);
        persist();
        return Promise.resolve(true);
      }
    },

    /* Matériaux affectés à un chantier — le stock suit chaque mouvement */
    materials: {
      list: (params = {}) => {
        if (config.mode === 'http') return request('/materials', { params });
        let list = ERP.DB.projectMaterials.slice();
        if (params.projectId && params.projectId !== 'tous') list = list.filter(m => m.projectId === params.projectId);
        if (params.articleId) list = list.filter(m => m.articleId === params.articleId);
        return Promise.resolve(list.map(decorateMaterial)
          .sort((a, b) => b.date.localeCompare(a.date)));
      },
      create: (m) => {
        if (config.mode === 'http') return request('/materials', { method: 'POST', body: m });
        const a = byId(ERP.DB.articles, m.articleId);
        if (!a) return Promise.reject(new Error('Article introuvable'));
        if (m.qty > a.stock) return Promise.reject(new Error('stock_insuffisant'));
        const item = Object.assign({
          id: 'AFF-' + Date.now().toString(36).toUpperCase(),
          date: ERP.DB.today, author: ERP.DB.user.name, note: ''
        }, m);
        ERP.DB.projectMaterials.push(item);
        moveStock(a, -item.qty);
        chargeProject(item.projectId, item.qty * a.price);
        persist();
        return Promise.resolve(decorateMaterial(item));
      },
      update: (id, patch) => {
        if (config.mode === 'http') return request('/materials/' + id, { method: 'PATCH', body: patch });
        const item = ERP.DB.projectMaterials.find(x => x.id === id);
        if (!item) return Promise.resolve(null);
        const a = byId(ERP.DB.articles, item.articleId);
        if (patch.qty != null && a) {
          const delta = patch.qty - item.qty;
          if (delta > a.stock) return Promise.reject(new Error('stock_insuffisant'));
          moveStock(a, -delta);
          chargeProject(item.projectId, delta * a.price);
        }
        Object.assign(item, patch);
        persist();
        return Promise.resolve(decorateMaterial(item));
      },
      remove: (id) => {
        if (config.mode === 'http') return request('/materials/' + id, { method: 'DELETE' });
        const i = ERP.DB.projectMaterials.findIndex(x => x.id === id);
        if (i > -1) {
          const item = ERP.DB.projectMaterials[i];
          const a = byId(ERP.DB.articles, item.articleId);
          if (a) { moveStock(a, item.qty); chargeProject(item.projectId, -item.qty * a.price); }
          ERP.DB.projectMaterials.splice(i, 1);
        }
        persist();
        return Promise.resolve(true);
      }
    },

    /* Fournisseurs de matériaux */
    suppliers: {
      list: (params = {}) => {
        if (config.mode === 'http') return request('/suppliers', { params });
        let list = ERP.DB.suppliers.map(decorateSupplier);
        if (params.status && params.status !== 'tous') list = list.filter(s => s.status === params.status);
        if (params.city && params.city !== 'tous') list = list.filter(s => s.city === params.city);
        if (params.q) {
          const q = params.q.toLowerCase();
          list = list.filter(s => (s.company + s.contact + s.city + s.specialty).toLowerCase().includes(q));
        }
        return Promise.resolve(list);
      },
      get: (id) => {
        if (config.mode === 'http') return request('/suppliers/' + id);
        const s = byId(ERP.DB.suppliers, id);
        if (!s) return Promise.resolve(null);
        return Promise.resolve(Object.assign(decorateSupplier(s), {
          articles: DB.articles.filter(a => a.supplierId === id)
            .map(a => Object.assign({}, a, { isFeatured: s.featured.includes(a.id) }))
            .sort((a, b) => (b.isFeatured - a.isFeatured) || a.name.localeCompare(b.name)),
          deliveries: DB.projectMaterials
            .filter(m => { const a = byId(DB.articles, m.articleId); return a && a.supplierId === id; })
            .map(m => {
              const a = byId(DB.articles, m.articleId), p = byId(DB.projects, m.projectId);
              return {
                id: m.id, date: m.date, qty: m.qty, unit: a.unit, article: a.name,
                amount: m.qty * a.price, projectName: p ? p.name : '—', projectId: m.projectId
              };
            }).sort((x, y) => y.date.localeCompare(x.date))
        }));
      },
      create: (s) => {
        if (config.mode === 'http') return request('/suppliers', { method: 'POST', body: s });
        const item = Object.assign({
          id: 'FRN-' + String(ERP.DB.suppliers.length + 1).padStart(3, '0'),
          since: ERP.DB.today, status: 'actif', featured: [],
          rating: 4, leadDays: 3, taxId: '', payment: '30 jours fin de mois', note: ''
        }, s);
        ERP.DB.suppliers.unshift(item);
        persist();
        return Promise.resolve(item);
      },
      update: (id, patch) => {
        if (config.mode === 'http') return request('/suppliers/' + id, { method: 'PATCH', body: patch });
        const s = byId(ERP.DB.suppliers, id);
        if (s) {
          const oldName = s.company;
          Object.assign(s, patch);
          // Les articles portent le nom du fournisseur : on le garde aligné
          if (patch.company && patch.company !== oldName) {
            DB.articles.filter(a => a.supplierId === id).forEach(a => { a.supplier = patch.company; });
          }
        }
        persist();
        return Promise.resolve(s);
      },
      remove: (id) => {
        if (config.mode === 'http') return request('/suppliers/' + id, { method: 'DELETE' });
        const i = ERP.DB.suppliers.findIndex(x => x.id === id);
        if (i > -1) ERP.DB.suppliers.splice(i, 1);
        persist();
        return Promise.resolve(true);
      },
      /** Épingle ou retire un matériau de la sélection « à la une ». */
      toggleFeatured: (id, articleId) => {
        if (config.mode === 'http') return request('/suppliers/' + id + '/featured/' + articleId, { method: 'POST' });
        const s = byId(ERP.DB.suppliers, id);
        if (!s) return Promise.resolve(null);
        const i = s.featured.indexOf(articleId);
        if (i > -1) s.featured.splice(i, 1); else s.featured.push(articleId);
        persist();
        return Promise.resolve({ featured: i === -1, count: s.featured.length });
      }
    },

    /* Référentiel de tâches, paramétrable depuis le module Tâches */
    taskCatalog: {
      list: () => config.mode === 'http' ? request('/task-catalog') : Promise.resolve(ERP.DB.taskCatalog.slice()),
      create: (c) => {
        if (config.mode === 'http') return request('/task-catalog', { method: 'POST', body: c });
        const item = Object.assign({
          id: 'CAT-' + String(ERP.DB.taskCatalog.length + 1).padStart(3, '0'),
          active: true, defaultDays: 10
        }, c);
        ERP.DB.taskCatalog.push(item);
        persist();
        return Promise.resolve(item);
      },
      update: (id, patch) => {
        if (config.mode === 'http') return request('/task-catalog/' + id, { method: 'PATCH', body: patch });
        const c = ERP.DB.taskCatalog.find(x => x.id === id);
        if (c) Object.assign(c, patch);
        persist();
        return Promise.resolve(c);
      },
      remove: (id) => {
        if (config.mode === 'http') return request('/task-catalog/' + id, { method: 'DELETE' });
        const i = ERP.DB.taskCatalog.findIndex(x => x.id === id);
        if (i > -1) ERP.DB.taskCatalog.splice(i, 1);
        persist();
        return Promise.resolve(true);
      }
    },

    /* Pièces jointes d'un chantier (plans, photos, PV) */
    attachments: {
      list: (projectId) => {
        if (config.mode === 'http') return request('/attachments/' + projectId);
        return Promise.resolve((ERP.DB.attachments[projectId] || []).slice()
          .sort((a, b) => b.date.localeCompare(a.date)));
      },
      create: (projectId, file) => {
        if (config.mode === 'http') return request('/attachments/' + projectId, { method: 'POST', body: file });
        const list = ERP.DB.attachments[projectId] || (ERP.DB.attachments[projectId] = []);
        const item = Object.assign({
          id: 'ATT-' + Date.now().toString(36).toUpperCase(),
          date: ERP.DB.today, author: ERP.DB.user.name, kind: 'document'
        }, file);
        list.push(item);
        persist();
        return Promise.resolve(item);
      },
      remove: (projectId, id) => {
        if (config.mode === 'http') return request('/attachments/' + projectId + '/' + id, { method: 'DELETE' });
        const list = ERP.DB.attachments[projectId] || [];
        const i = list.findIndex(x => x.id === id);
        if (i > -1) list.splice(i, 1);
        persist();
        return Promise.resolve(true);
      }
    },

    /* Devis établis depuis une fiche client */
    quotes: {
      list: (clientId) => {
        if (config.mode === 'http') return request('/quotes', { params: clientId ? { clientId } : null });
        return Promise.resolve(ERP.DB.quotes.filter(q => !clientId || q.clientId === clientId));
      },
      get: (id) => {
        if (config.mode === 'http') return request('/quotes/' + id);
        return Promise.resolve(ERP.DB.quotes.find(q => q.id === id));
      },
      create: (q) => {
        if (config.mode === 'http') return request('/quotes', { method: 'POST', body: q });
        const year = ERP.DB.today.slice(0, 4);
        const n = ERP.DB.quotes.length + 1;
        const item = Object.assign({
          id: 'DEV-' + year + '-' + String(n).padStart(3, '0'),
          date: ERP.DB.today, status: 'en_attente', projectId: null
        }, q);
        item.total = (item.lines || []).reduce((s, l) => s + l.qty * l.price, 0);
        ERP.DB.quotes.unshift(item);
        persist();
        return Promise.resolve(item);
      },
      update: (id, patch) => {
        if (config.mode === 'http') return request('/quotes/' + id, { method: 'PATCH', body: patch });
        const q = ERP.DB.quotes.find(x => x.id === id);
        if (q) Object.assign(q, patch);
        persist();
        return Promise.resolve(q);
      },
      remove: (id) => {
        if (config.mode === 'http') return request('/quotes/' + id, { method: 'DELETE' });
        const i = ERP.DB.quotes.findIndex(x => x.id === id);
        if (i > -1) ERP.DB.quotes.splice(i, 1);
        persist();
        return Promise.resolve(true);
      }
    },
    clients: {
      list: (params) => request('/clients', { params }),
      get: (id) => request('/clients/' + id),
      create: (c) => {
        if (config.mode === 'http') return request('/clients', { method: 'POST', body: c });
        const item = Object.assign({
          id: 'CLI-' + String(ERP.DB.clients.length + 1).padStart(3, '0'),
          since: ERP.DB.today, status: 'actif', address: '', phone: '', email: ''
        }, c);
        ERP.DB.clients.unshift(item);
        persist();
        return Promise.resolve(item);
      },
      update: (id, patch) => {
        if (config.mode === 'http') return request('/clients/' + id, { method: 'PATCH', body: patch });
        const c = ERP.DB.clients.find(x => x.id === id);
        if (c) Object.assign(c, patch);
        persist();
        return Promise.resolve(c);
      },
      remove: (id) => {
        if (config.mode === 'http') return request('/clients/' + id, { method: 'DELETE' });
        const i = ERP.DB.clients.findIndex(x => x.id === id);
        if (i > -1) ERP.DB.clients.splice(i, 1);
        persist();
        return Promise.resolve(true);
      }
    },
    workers: {
      list: (params) => request('/workers', { params }),
      get: (id) => request('/workers/' + id),
      create: (w) => {
        if (config.mode === 'http') return request('/workers', { method: 'POST', body: w });
        const item = Object.assign({
          id: 'OUV-' + String(ERP.DB.workers.length + 1).padStart(3, '0'),
          trade: 'Maçon', rate: 15, projectId: null, phone: '', status: 'actif'
        }, w);
        ERP.DB.workers.unshift(item);
        persist();
        return Promise.resolve(item);
      },
      update: (id, patch) => {
        if (config.mode === 'http') return request('/workers/' + id, { method: 'PATCH', body: patch });
        const w = ERP.DB.workers.find(x => x.id === id);
        if (w) Object.assign(w, patch);
        persist();
        return Promise.resolve(w);
      },
      remove: (id) => {
        if (config.mode === 'http') return request('/workers/' + id, { method: 'DELETE' });
        const i = ERP.DB.workers.findIndex(x => x.id === id);
        if (i > -1) ERP.DB.workers.splice(i, 1);
        persist();
        return Promise.resolve(true);
      }
    },
    timesheets: {
      list: (params) => request('/timesheets', { params }),
      summary: (params) => request('/timesheets/summary', { params }),
      create: (entry) => {
        if (config.mode === 'http') return request('/timesheets', { method: 'POST', body: entry });
        // Écriture simulée : la ligne est injectée dans le jeu de données en mémoire.
        const rows = ERP.DB.timesheets(entry.date);
        const worker = ERP.DB.workers.find(w => w.id === entry.workerId);
        const hours = Math.max(0, (entry.out - entry.in - entry.breakMin) / 60);
        const existing = rows.find(r => r.workerId === entry.workerId);
        const row = {
          id: 'PTG-' + entry.date + '-' + entry.workerId, date: entry.date,
          workerId: entry.workerId, worker: worker ? worker.name : '—',
          trade: worker ? worker.trade : '—', projectId: entry.projectId,
          in: entry.in, out: entry.out, breakMin: entry.breakMin, hours,
          status: entry.status || (entry.in > 435 ? 'retard' : 'present'),
          note: entry.note || ''
        };
        if (existing) Object.assign(existing, row); else rows.push(row);
        persist();
        return Promise.resolve(row);
      },
      update: (id, patch) => {
        if (config.mode === 'http') return request('/timesheets/' + id, { method: 'PATCH', body: patch });
        // Chercher dans le cache des pointages
        const cache = {}; // fallback: scan via timesheets of recent days
        for (let i = 0; i < 30; i++) {
          const d = ERP.dt.add(ERP.DB.today, -i);
          const rows = ERP.DB.timesheets(d);
          const row = rows.find(r => r.id === id);
          if (row) {
            Object.assign(row, patch);
            if (patch.in != null || patch.out != null || patch.breakMin != null) {
              row.hours = Math.max(0, (row.out - row.in - (row.breakMin || 0)) / 60);
            }
            persist();
            return Promise.resolve(row);
          }
        }
        return Promise.resolve(null);
      },
      remove: (id) => {
        if (config.mode === 'http') return request('/timesheets/' + id, { method: 'DELETE' });
        for (let i = 0; i < 30; i++) {
          const d = ERP.dt.add(ERP.DB.today, -i);
          const rows = ERP.DB.timesheets(d);
          const idx = rows.findIndex(r => r.id === id);
          if (idx > -1) {
            rows.splice(idx, 1);
            persist();
            return Promise.resolve(true);
          }
        }
        return Promise.resolve(false);
      }
    },
    articles: {
      list: (params) => request('/articles', { params }),
      get: (id) => request('/articles/' + id),
      create: (a) => {
        if (config.mode === 'http') return request('/articles', { method: 'POST', body: a });
        const id = 'ART-' + String(ERP.DB.articles.length + 1).padStart(3, '0');
        const item = Object.assign({
          id, ref: 'MAT-' + String(ERP.DB.articles.length + 1).padStart(4, '0'),
          location: 'Dépôt central Tunis', lastEntry: ERP.DB.today
        }, a);
        item.stockStatus = item.stock === 0 ? 'rupture' : (item.stock < item.min ? 'faible' : 'ok');
        ERP.DB.articles.unshift(item);
        persist();
        return Promise.resolve(item);
      },
      update: (id, patch) => {
        if (config.mode === 'http') return request('/articles/' + id, { method: 'PATCH', body: patch });
        const a = ERP.DB.articles.find(x => x.id === id);
        if (a) {
          Object.assign(a, patch);
          a.stockStatus = a.stock === 0 ? 'rupture' : (a.stock < a.min ? 'faible' : 'ok');
        }
        persist();
        return Promise.resolve(a);
      },
      remove: (id) => {
        if (config.mode === 'http') return request('/articles/' + id, { method: 'DELETE' });
        const i = ERP.DB.articles.findIndex(x => x.id === id);
        if (i > -1) ERP.DB.articles.splice(i, 1);
        persist();
        return Promise.resolve(true);
      }
    },
    tasks: {
      list: (params) => request('/tasks', { params }),
      create: (t) => {
        if (config.mode === 'http') return request('/tasks', { method: 'POST', body: t });
        const item = Object.assign({
          id: 'TSK-' + String(ERP.DB.tasks.length + 1).padStart(3, '0'),
          progress: 0, status: 'a_faire', createdAt: ERP.DB.today
        }, t);
        ERP.DB.tasks.unshift(item);
        persist();
        return Promise.resolve(item);
      },
      update: (id, patch) => {
        if (config.mode === 'http') return request('/tasks/' + id, { method: 'PATCH', body: patch });
        const t = ERP.DB.tasks.find(x => x.id === id);
        if (t) {
          Object.assign(t, patch);
          // Le lot correspondant du planning suit la tâche (dates et avancement)
          const p = ERP.DB.projects.find(x => x.id === t.projectId);
          const phase = p && (p.phases || []).find(ph => ph.taskId === id);
          if (phase) {
            phase.name = t.title; phase.start = t.start; phase.end = t.due;
            phase.progress = t.progress; phase.lead = t.assignee;
          }
        }
        persist();
        return Promise.resolve(t);
      },
      remove: (id) => {
        if (config.mode === 'http') return request('/tasks/' + id, { method: 'DELETE' });
        const t = ERP.DB.tasks.find(x => x.id === id);
        if (t) {
          const p = ERP.DB.projects.find(x => x.id === t.projectId);
          if (p && p.phases) {
            const i = p.phases.findIndex(ph => ph.taskId === id);
            if (i > -1) p.phases.splice(i, 1);
          }
        }
        const i = ERP.DB.tasks.findIndex(x => x.id === id);
        if (i > -1) ERP.DB.tasks.splice(i, 1);
        persist();
        return Promise.resolve(true);
      }
    },
    budget: {
      summary: () => request('/budget/summary'),
      categories: (params) => request('/budget/categories', { params }),
      projects: () => request('/budget/projects')
    },
    planning: {
      rows: (params) => request('/planning', { params })
    },
    reports: {
      attendance: () => request('/reports/attendance'),
      trades: () => request('/reports/trades')
    },
    notifications: {
      list: () => request('/notifications'),
      markRead: (id) => {
        if (config.mode === 'http') return request('/notifications/' + id + '/read', { method: 'PATCH' });
        const n = ERP.DB.notifications.find(x => x.id === id);
        if (n) n.read = true;
        persist();
        return Promise.resolve(n);
      },
      markAllRead: () => {
        if (config.mode === 'http') return request('/notifications/read-all', { method: 'POST' });
        ERP.DB.notifications.forEach(n => { n.read = true; });
        persist();
        return Promise.resolve(true);
      }
    },
    search: (q) => request('/search', { params: { q } })
  };
})(window.ERP);
