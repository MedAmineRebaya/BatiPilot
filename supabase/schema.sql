-- =========================================================
-- BâtiPilot — Supabase schema + Row Level Security
-- ---------------------------------------------------------
-- Run once in the Supabase SQL editor (Project → SQL Editor → New query).
-- Safe to re-run: every statement is guarded with IF NOT EXISTS /
-- CREATE OR REPLACE / DROP POLICY IF EXISTS.
-- =========================================================

-- ---------------------------------------------------------
-- 1. profiles — one row per auth user, drives role-based access
-- ---------------------------------------------------------
create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null default '',
  initials text not null default '',
  email text not null default '',
  role text not null default 'ingenieur' check (role in ('admin', 'ingenieur', 'assistant')),
  phone text not null default '',
  agency text not null default '',
  active boolean not null default true,
  since date not null default current_date,
  created_at timestamptz not null default now(),
  -- null for admin; an ingénieur's own id (self — "a company"); an
  -- assistant's employing ingénieur's id.
  company_id uuid references profiles(id)
);

-- Migration for databases created before 'assistant'/company_id existed.
alter table profiles drop constraint if exists profiles_role_check;
alter table profiles add constraint profiles_role_check check (role in ('admin', 'ingenieur', 'assistant'));
alter table profiles add column if not exists company_id uuid references profiles(id);

-- Auto-create a profile row whenever someone signs up (invite or self-signup)
create or replace function handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into profiles (id, email, full_name, initials, company_id)
  values (
    new.id,
    coalesce(new.email, ''),
    coalesce(new.raw_user_meta_data ->> 'full_name', split_part(coalesce(new.email, ''), '@', 1)),
    upper(left(coalesce(new.raw_user_meta_data ->> 'full_name', new.email, '?'), 1)),
    -- Default: a new account is its own company (ingénieur). The
    -- assistant-invite endpoint immediately overrides role/company_id
    -- via the service-role client right after this trigger runs.
    new.id
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- Helper: is the calling user an admin? (security definer avoids RLS recursion)
create or replace function is_admin()
returns boolean
language sql
security definer set search_path = public
stable
as $$
  select exists (
    select 1 from profiles where id = auth.uid() and role = 'admin' and active
  );
$$;

-- ---------------------------------------------------------
-- 2. project_members — which engineer can see which project
-- ---------------------------------------------------------
create table if not exists project_members (
  project_id text not null,
  user_id uuid not null references profiles(id) on delete cascade,
  added_at timestamptz not null default now(),
  primary key (project_id, user_id)
);

-- Membership additionally requires the caller's own profile to be active,
-- so a not-yet-approved signup or a deactivated engineer is blocked even
-- if already (or still) listed in project_members.
create or replace function is_project_member(p_project_id text)
returns boolean
language sql
security definer set search_path = public
stable
as $$
  select exists (
    select 1 from project_members pm
    join profiles p on p.id = pm.user_id
    where pm.project_id = p_project_id and pm.user_id = auth.uid() and p.active
  );
$$;

-- ---------------------------------------------------------
-- 3. Domain tables (string IDs kept as-is, e.g. PRJ-001, CLI-001)
-- ---------------------------------------------------------
create table if not exists clients (
  id text primary key,
  contact text not null default '',
  company text not null default '',
  city text not null default '',
  phone text not null default '',
  email text not null default '',
  status text not null default 'actif',
  since date not null default current_date,
  address text not null default ''
);

create table if not exists projects (
  id text primary key,
  ref text not null default '',
  name text not null default '',
  client_id text references clients(id) on delete set null,
  address text not null default '',
  city text not null default '',
  manager text not null default '',
  start date,
  "end" date,
  status text not null default 'en_preparation',
  progress int not null default 0,
  budget numeric not null default 0,
  spent numeric not null default 0,
  type text not null default '',
  phases jsonb not null default '[]'::jsonb,
  created_by uuid references profiles(id)
);

create table if not exists workers (
  id text primary key,
  matricule text not null default '',
  name text not null default '',
  trade text not null default '',
  project_id text references projects(id) on delete set null,
  phone text not null default '',
  rate numeric not null default 15,
  cnss text not null default '',
  since date not null default current_date,
  contract text not null default 'Journalier',
  status text not null default 'actif'
);

create table if not exists suppliers (
  id text primary key,
  company text not null default '',
  contact text not null default '',
  phone text not null default '',
  email text not null default '',
  address text not null default '',
  city text not null default '',
  specialty text not null default '',
  lead_days int not null default 3,
  rating numeric not null default 4,
  tax_id text not null default '',
  payment text not null default '',
  since date not null default current_date,
  status text not null default 'actif',
  featured jsonb not null default '[]'::jsonb,
  note text not null default ''
);

create table if not exists articles (
  id text primary key,
  ref text not null default '',
  name text not null default '',
  category text not null default '',
  unit text not null default '',
  stock numeric not null default 0,
  min numeric not null default 0,
  price numeric not null default 0,
  supplier text not null default '',
  supplier_id text references suppliers(id) on delete set null,
  location text not null default '',
  last_entry date,
  stock_status text not null default 'ok'
);

create table if not exists tasks (
  id text primary key,
  title text not null default '',
  project_id text references projects(id) on delete cascade,
  assignee text not null default '',
  priority text not null default 'moyenne',
  start date,
  due date,
  progress int not null default 0,
  status text not null default 'a_faire',
  created_at date not null default current_date
);

create table if not exists project_materials (
  id text primary key,
  project_id text references projects(id) on delete cascade,
  article_id text references articles(id) on delete restrict,
  qty numeric not null default 0,
  date date not null default current_date,
  note text not null default '',
  author text not null default ''
);

-- Pas de unique(date, worker_id) : un ouvrier peut être pointé sur
-- plusieurs chantiers le même jour (ex. 7h-12h sur un chantier, 13h-fin
-- sur un autre). La non-superposition des horaires est vérifiée côté
-- API (POST/PATCH /timesheets), pas par une contrainte de table.
create table if not exists timesheets (
  id text primary key,
  date date not null,
  worker_id text references workers(id) on delete cascade,
  worker text not null default '',
  trade text not null default '',
  project_id text references projects(id) on delete set null,
  "in" int,
  "out" int,
  break_min int not null default 0,
  hours numeric not null default 0,
  status text not null default 'present',
  note text not null default ''
);

create table if not exists task_catalog (
  id text primary key,
  name text not null default '',
  category text not null default '',
  default_days int not null default 10,
  trade text not null default '',
  active boolean not null default true
);

create table if not exists attachments (
  id text primary key,
  project_id text references projects(id) on delete cascade,
  name text not null default '',
  kind text not null default 'document',
  size bigint not null default 0,
  date date not null default current_date,
  author text not null default ''
);

create table if not exists quotes (
  id text primary key,
  client_id text references clients(id) on delete set null,
  title text not null default '',
  date date not null default current_date,
  status text not null default 'en_attente',
  project_id text references projects(id) on delete set null,
  lines jsonb not null default '[]'::jsonb,
  total numeric not null default 0,
  city text not null default '',
  valid_until date,
  start_date date,
  months int not null default 8
);

-- Migration for databases created before these columns existed — the
-- client form has always sent city/validUntil/startDate/months (openQuote()
-- in clients.js, and convertQuote() reads them straight back to build the
-- project a quote converts into), but the table never had them: every
-- quote insert failed on "Could not find the 'city' column" and the
-- feature never actually worked.
alter table quotes add column if not exists city text not null default '';
alter table quotes add column if not exists valid_until date;
alter table quotes add column if not exists start_date date;
alter table quotes add column if not exists months int not null default 8;

-- Migration for databases created before multi-chantier pointage:
-- un ouvrier ne pouvait être pointé que sur un seul chantier par jour.
-- Le nom par défaut de la contrainte auto-générée par Postgres pour
-- `unique (date, worker_id)` est `timesheets_date_worker_id_key`.
alter table timesheets drop constraint if exists timesheets_date_worker_id_key;

create table if not exists expenses (
  id text primary key,
  project_id text references projects(id) on delete cascade,
  category text not null default '',
  label text not null default '',
  amount numeric not null default 0
);

create table if not exists cost_categories (
  key text primary key,
  label text not null default '',
  share numeric not null default 0,
  color text not null default '#888888'
);

create table if not exists notifications (
  id text primary key,
  project_id text references projects(id) on delete cascade,
  level text not null default 'info',
  title text not null default '',
  text text not null default '',
  time text not null default '',
  link text not null default '',
  read boolean not null default false
);

create table if not exists activity (
  id bigint generated always as identity primary key,
  project_id text references projects(id) on delete cascade,
  icon text not null default '',
  tone text not null default 'info',
  title text not null default '',
  meta text not null default '',
  time text not null default ''
);

-- Migration for databases created before this column existed
-- (CREATE TABLE IF NOT EXISTS above is a no-op on an existing table).
alter table projects add column if not exists created_by uuid references profiles(id);

-- Any active user (admin or engineer) may create a project; the API sets
-- created_by and auto-assigns the creator as a project_member.
create or replace function is_active()
returns boolean
language sql
security definer set search_path = public
stable
as $$
  select exists (select 1 from profiles where id = auth.uid() and active);
$$;

drop policy if exists projects_insert_active on projects;
create policy projects_insert_active on projects for insert
  with check (is_active());

-- ---------------------------------------------------------
-- 4. Row Level Security
-- ---------------------------------------------------------
alter table profiles enable row level security;
alter table project_members enable row level security;
alter table clients enable row level security;
alter table projects enable row level security;
alter table workers enable row level security;
alter table suppliers enable row level security;
alter table articles enable row level security;
alter table tasks enable row level security;
alter table project_materials enable row level security;
alter table timesheets enable row level security;
alter table task_catalog enable row level security;
alter table attachments enable row level security;
alter table quotes enable row level security;
alter table expenses enable row level security;
alter table cost_categories enable row level security;
alter table notifications enable row level security;
alter table activity enable row level security;

-- profiles: everyone reads their own row; admin reads/writes all
drop policy if exists profiles_self_select on profiles;
create policy profiles_self_select on profiles for select
  using (id = auth.uid() or is_admin());
drop policy if exists profiles_admin_write on profiles;
create policy profiles_admin_write on profiles for all
  using (is_admin()) with check (is_admin());
drop policy if exists profiles_self_update on profiles;
create policy profiles_self_update on profiles for update
  using (id = auth.uid()) with check (id = auth.uid());

-- RLS policies operate on rows, not columns — profiles_self_update above
-- would otherwise let a user change their OWN role/active via a direct
-- REST call (bypassing the app's admin-only endpoints entirely). Block
-- that at the trigger level. auth.uid() is null for service-role calls
-- (our admin API), which is how admins actually change these columns —
-- so only block when a real user JWT is present and isn't an admin.
create or replace function prevent_self_privilege_escalation()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if auth.uid() is not null and not is_admin()
     and (new.role is distinct from old.role or new.active is distinct from old.active) then
    raise exception 'Seul un administrateur peut modifier le rôle ou le statut actif';
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_prevent_escalation on profiles;
create trigger profiles_prevent_escalation
  before update on profiles
  for each row execute function prevent_self_privilege_escalation();

-- project_members: admin manages; a user can read their own memberships
drop policy if exists members_admin_all on project_members;
create policy members_admin_all on project_members for all
  using (is_admin()) with check (is_admin());
drop policy if exists members_self_select on project_members;
create policy members_self_select on project_members for select
  using (user_id = auth.uid());

-- projects: admin full access; engineer reads/updates only their own project(s)
drop policy if exists projects_admin_all on projects;
create policy projects_admin_all on projects for all
  using (is_admin()) with check (is_admin());
drop policy if exists projects_member_select on projects;
create policy projects_member_select on projects for select
  using (is_project_member(id));
drop policy if exists projects_member_update on projects;
create policy projects_member_update on projects for update
  using (is_project_member(id)) with check (is_project_member(id));

-- clients: admin full access; engineer reads only the client tied to their project(s)
drop policy if exists clients_admin_all on clients;
create policy clients_admin_all on clients for all
  using (is_admin()) with check (is_admin());
drop policy if exists clients_member_select on clients;
create policy clients_member_select on clients for select
  using (exists (
    select 1 from projects p
    where p.client_id = clients.id and is_project_member(p.id)
  ));

-- workers / tasks / project_materials / timesheets / attachments / expenses / notifications / activity:
-- admin full access; engineer full CRUD scoped to their project(s)
do $$
declare
  t text;
begin
  foreach t in array array['workers', 'tasks', 'project_materials', 'timesheets', 'attachments', 'expenses', 'notifications', 'activity']
  loop
    execute format('drop policy if exists %I_admin_all on %I', t, t);
    execute format('create policy %I_admin_all on %I for all using (is_admin()) with check (is_admin())', t, t);
    execute format('drop policy if exists %I_member_all on %I', t, t);
    execute format(
      'create policy %I_member_all on %I for all using (project_id is null or is_project_member(project_id)) with check (project_id is not null and is_project_member(project_id))',
      t, t
    );
  end loop;
end $$;

-- quotes: admin full access; engineer reads quotes tied to their project(s)
drop policy if exists quotes_admin_all on quotes;
create policy quotes_admin_all on quotes for all
  using (is_admin()) with check (is_admin());
drop policy if exists quotes_member_select on quotes;
create policy quotes_member_select on quotes for select
  using (project_id is not null and is_project_member(project_id));

-- suppliers / task_catalog / cost_categories: shared reference data,
-- readable by any authenticated user, writable by admin only
do $$
declare
  t text;
begin
  foreach t in array array['suppliers', 'task_catalog', 'cost_categories']
  loop
    execute format('drop policy if exists %I_read_all on %I', t, t);
    execute format('create policy %I_read_all on %I for select using (auth.uid() is not null)', t, t);
    execute format('drop policy if exists %I_admin_write on %I', t, t);
    execute format('create policy %I_admin_write on %I for insert with check (is_admin())', t, t);
    execute format('drop policy if exists %I_admin_update on %I', t, t);
    execute format('create policy %I_admin_update on %I for update using (is_admin()) with check (is_admin())', t, t);
    execute format('drop policy if exists %I_admin_delete on %I', t, t);
    execute format('create policy %I_admin_delete on %I for delete using (is_admin())', t, t);
  end loop;
end $$;

-- articles: shared stock catalog — any authenticated user reads and updates
-- stock (needed when logging material usage on their project); only admin
-- creates/removes catalog entries.
drop policy if exists articles_read_all on articles;
create policy articles_read_all on articles for select
  using (auth.uid() is not null);
drop policy if exists articles_update_all on articles;
create policy articles_update_all on articles for update
  using (auth.uid() is not null) with check (auth.uid() is not null);
drop policy if exists articles_admin_insert on articles;
create policy articles_admin_insert on articles for insert
  with check (is_admin());
drop policy if exists articles_admin_delete on articles;
create policy articles_admin_delete on articles for delete
  using (is_admin());

-- =========================================================
-- PHASE 2 — Multi-tenant roles (admin / ingénieur / assistant)
-- ---------------------------------------------------------
-- admin:      platform owner. Manages companies (= ingénieur accounts).
--             No operational data of his own.
-- ingénieur:  a company. Full CRUD on everything he owns.
-- assistant:  belongs to exactly one ingénieur (profiles.company_id).
--             Read-only everywhere his company can see, EXCEPT full
--             CRUD on the `workers` table of that company.
-- Re-run safe: every statement is guarded.
-- =========================================================

-- ---------------------------------------------------------
-- 1. company_id on tables that can exist before/without a project —
--    everything else derives its company via project_id → projects.
-- ---------------------------------------------------------
alter table projects      add column if not exists company_id uuid references profiles(id);
alter table workers       add column if not exists company_id uuid references profiles(id);
alter table clients       add column if not exists company_id uuid references profiles(id);
alter table articles      add column if not exists company_id uuid references profiles(id);
alter table suppliers     add column if not exists company_id uuid references profiles(id);
alter table notifications add column if not exists company_id uuid references profiles(id);
alter table activity      add column if not exists company_id uuid references profiles(id);
alter table quotes        add column if not exists company_id uuid references profiles(id);

-- Backfill so nothing already seeded goes orphaned.
update projects set company_id = coalesce(company_id, created_by);
update projects p set company_id = (select pm.user_id from project_members pm where pm.project_id = p.id limit 1)
  where company_id is null;
update workers w set company_id = (select p.company_id from projects p where p.id = w.project_id)
  where company_id is null and project_id is not null;
update clients c set company_id = (
    select p.company_id from projects p where p.client_id = c.id and p.company_id is not null limit 1
  ) where company_id is null;
update quotes q set company_id = (select p.company_id from projects p where p.id = q.project_id)
  where company_id is null and project_id is not null;
update notifications n set company_id = (select p.company_id from projects p where p.id = n.project_id)
  where company_id is null and project_id is not null;
update activity a set company_id = (select p.company_id from projects p where p.id = a.project_id)
  where company_id is null and project_id is not null;
-- articles / suppliers: no project_id to backfill from at all (shared
-- demo/reference data in the old single-tenant model) — left with
-- company_id null, which from here on means "legacy platform fixture,
-- admin-only" rather than "shared with everyone" (see policies below).
-- Same applies to any notification/activity row with a null project_id
-- (company-wide alerts, e.g. stock/attendance) — there's no signal to
-- attribute those to a company automatically; re-create them per-company
-- (or set company_id by hand) after the migration if you need them back.

-- ---------------------------------------------------------
-- 2. company-scope helpers
-- ---------------------------------------------------------
-- The caller's effective company: their own id if they're an ingénieur
-- (a company), their employer's id if they're an assistant, null
-- otherwise (admin, or an inactive/unknown caller).
create or replace function my_company()
returns uuid
language sql
security definer set search_path = public
stable
as $$
  select case p.role
    when 'ingenieur' then p.id
    when 'assistant' then p.company_id
    else null
  end
  from profiles p where p.id = auth.uid() and p.active;
$$;

create or replace function is_ingenieur()
returns boolean
language sql
security definer set search_path = public
stable
as $$
  select exists (select 1 from profiles where id = auth.uid() and role = 'ingenieur' and active);
$$;

-- Redefining is_project_member (rather than introducing a new name)
-- upgrades every existing policy that already calls it — projects,
-- clients, quotes, and the tasks/timesheets/project_materials/
-- attachments/expenses loop below — to the company model for free,
-- including transitively covering assistants (my_company() resolves to
-- their employer's id). project_members is kept as a secondary path for
-- backward compatibility with any explicit membership rows.
create or replace function is_project_member(p_project_id text)
returns boolean
language sql
security definer set search_path = public
stable
as $$
  select
    exists (select 1 from projects p where p.id = p_project_id and p.company_id = my_company())
    or exists (
      select 1 from project_members pm where pm.project_id = p_project_id and pm.user_id = my_company()
    );
$$;

-- ---------------------------------------------------------
-- 3. profiles: an ingénieur may see (not write) his own assistants'
--    rows; the escalation trigger also protects company_id now (an
--    assistant re-parenting themselves would grant access to another
--    company's data).
-- ---------------------------------------------------------
drop policy if exists profiles_company_select on profiles;
create policy profiles_company_select on profiles for select
  using (is_ingenieur() and company_id = auth.uid());

create or replace function prevent_self_privilege_escalation()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if auth.uid() is not null and not is_admin()
     and (new.role is distinct from old.role
          or new.active is distinct from old.active
          or new.company_id is distinct from old.company_id) then
    raise exception 'Seul un administrateur peut modifier le rôle, le statut actif ou le rattachement d''entreprise';
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------
-- 4. projects: creation restricted to an ingénieur (not an assistant,
--    not just "any active user" as the earlier policy allowed).
-- ---------------------------------------------------------
drop policy if exists projects_insert_active on projects;
drop policy if exists projects_insert_ingenieur on projects;
create policy projects_insert_ingenieur on projects for insert
  with check (is_ingenieur() and company_id = auth.uid());

drop policy if exists projects_member_update on projects;
create policy projects_member_update on projects for update
  using (is_project_member(id) and is_ingenieur())
  with check (is_project_member(id) and is_ingenieur());

-- No delete policy existed for the ingénieur role at all (only
-- projects_admin_all covered delete) — DELETE /api/v1/projects/:id ran
-- through the caller's own RLS-scoped client, so an ingénieur deleting
-- their own project silently affected 0 rows: no error, but the project
-- was still there after the "Projet supprimé" toast.
drop policy if exists projects_company_delete on projects;
create policy projects_company_delete on projects for delete
  using (is_project_member(id) and is_ingenieur());

-- ---------------------------------------------------------
-- 5. workers: the one table an assistant gets full CRUD on. Scoped by
--    workers.company_id directly (not the generic project_id-based
--    pattern below) so an unassigned worker (project_id null) stays
--    inside its own company instead of being visible to every company.
-- ---------------------------------------------------------
drop policy if exists workers_member_all on workers;
drop policy if exists workers_company_all on workers;
create policy workers_company_all on workers for all
  using (company_id is not null and company_id = my_company())
  with check (company_id is not null and company_id = my_company());

-- ---------------------------------------------------------
-- 6. tasks / timesheets / project_materials / attachments / expenses:
--    read for the whole company (ingénieur + assistant); write
--    restricted to the ingénieur only.
-- ---------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['tasks', 'timesheets', 'project_materials', 'attachments', 'expenses']
  loop
    execute format('drop policy if exists %I_member_all on %I', t, t);
    execute format('drop policy if exists %I_company_select on %I', t, t);
    execute format('drop policy if exists %I_company_write on %I', t, t);
    execute format(
      'create policy %I_company_select on %I for select using (project_id is not null and is_project_member(project_id))',
      t, t
    );
    execute format(
      'create policy %I_company_write on %I for all using (project_id is not null and is_project_member(project_id) and is_ingenieur()) with check (project_id is not null and is_project_member(project_id) and is_ingenieur())',
      t, t
    );
  end loop;
end $$;

-- ---------------------------------------------------------
-- 7. clients / quotes: company-scoped via their own company_id,
--    ingénieur-only writes.
-- ---------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['clients', 'quotes']
  loop
    execute format('drop policy if exists %I_member_select on %I', t, t);
    execute format('drop policy if exists %I_company_select on %I', t, t);
    execute format('drop policy if exists %I_company_write on %I', t, t);
    execute format(
      'create policy %I_company_select on %I for select using (company_id is not null and company_id = my_company())',
      t, t
    );
    execute format(
      'create policy %I_company_write on %I for all using (company_id is not null and company_id = my_company() and is_ingenieur()) with check (is_ingenieur() and company_id = auth.uid())',
      t, t
    );
  end loop;
end $$;

-- ---------------------------------------------------------
-- 8. articles / suppliers: now a per-company stock catalog and
--    supplier book (no longer a platform-wide shared catalog) — read
--    for the whole company, write for the ingénieur only. Rows with a
--    null company_id are legacy platform fixtures, admin-only from
--    here on.
-- ---------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['articles', 'suppliers']
  loop
    execute format('drop policy if exists %I_read_all on %I', t, t);
    execute format('drop policy if exists %I_update_all on %I', t, t);
    execute format('drop policy if exists %I_admin_insert on %I', t, t);
    execute format('drop policy if exists %I_admin_delete on %I', t, t);
    execute format('drop policy if exists %I_company_select on %I', t, t);
    execute format('drop policy if exists %I_company_write on %I', t, t);
    execute format(
      'create policy %I_company_select on %I for select using (company_id is not null and company_id = my_company())',
      t, t
    );
    execute format(
      'create policy %I_company_write on %I for all using (company_id is not null and company_id = my_company() and is_ingenieur()) with check (is_ingenieur() and company_id = auth.uid())',
      t, t
    );
  end loop;
end $$;

-- ---------------------------------------------------------
-- 9. notifications / activity: company-scoped read; any company member
--    may mark a notification read (not sensitive); creation stays
--    ingénieur-only (admin already has full access via the earlier
--    *_admin_all policies from Phase 1, untouched here).
-- ---------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['notifications', 'activity']
  loop
    execute format('drop policy if exists %I_member_all on %I', t, t);
    execute format('drop policy if exists %I_company_select on %I', t, t);
    execute format('drop policy if exists %I_company_insert on %I', t, t);
    execute format(
      'create policy %I_company_select on %I for select using (company_id is not null and company_id = my_company())',
      t, t
    );
    execute format(
      'create policy %I_company_insert on %I for insert with check (is_ingenieur() and company_id = auth.uid())',
      t, t
    );
  end loop;
end $$;

drop policy if exists notifications_company_update on notifications;
create policy notifications_company_update on notifications for update
  using (company_id is not null and company_id = my_company())
  with check (company_id is not null and company_id = my_company());

-- =========================================================
-- PHASE 3 — Real file storage for project attachments
-- ---------------------------------------------------------
-- attachments never actually stored a file: the client generated a
-- browser-local blob: URL (dead the moment the tab closes, invisible to
-- every other device/user) and the server tried to save it into a `url`
-- column that didn't exist — every upload/photo attach was silently
-- failing. Fixed by adding the column and a real Supabase Storage bucket
-- that the client now uploads to directly (bypasses the API's request
-- body size limit entirely, which matters for camera photos).
-- =========================================================
alter table attachments add column if not exists url text not null default '';

insert into storage.buckets (id, name, public)
values ('attachments', 'attachments', true)
on conflict (id) do nothing;

-- Any authenticated user may upload/delete within the 'attachments'
-- bucket — the attachments TABLE's own RLS (ingénieur-write, company-read,
-- above) is what actually restricts who can attach a file to which
-- project; this only gates raw storage access, scoped to the one bucket.
-- The bucket is public so `getPublicUrl()` links work without a signed
-- URL — anyone with the exact random path can view a file, the same
-- trade-off as most app-asset buckets.
drop policy if exists attachments_bucket_select on storage.objects;
create policy attachments_bucket_select on storage.objects for select
  using (bucket_id = 'attachments');
drop policy if exists attachments_bucket_insert on storage.objects;
create policy attachments_bucket_insert on storage.objects for insert
  with check (bucket_id = 'attachments' and auth.uid() is not null);
drop policy if exists attachments_bucket_delete on storage.objects;
create policy attachments_bucket_delete on storage.objects for delete
  using (bucket_id = 'attachments' and auth.uid() is not null);

-- =========================================================
-- Done. Next: run supabase/seed-to-supabase.mjs to load db_seed.json,
-- then promote yourself:
--   update profiles set role = 'admin' where email = 'you@example.com';
-- =========================================================
