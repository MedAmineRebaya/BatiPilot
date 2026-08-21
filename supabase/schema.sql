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
  role text not null default 'ingenieur' check (role in ('admin', 'ingenieur')),
  phone text not null default '',
  agency text not null default '',
  active boolean not null default true,
  since date not null default current_date,
  created_at timestamptz not null default now()
);

-- Auto-create a profile row whenever someone signs up (invite or self-signup)
create or replace function handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into profiles (id, email, full_name, initials)
  values (
    new.id,
    coalesce(new.email, ''),
    coalesce(new.raw_user_meta_data ->> 'full_name', split_part(coalesce(new.email, ''), '@', 1)),
    upper(left(coalesce(new.raw_user_meta_data ->> 'full_name', new.email, '?'), 1))
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
  phases jsonb not null default '[]'::jsonb
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
  note text not null default '',
  unique (date, worker_id)
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
  total numeric not null default 0
);

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
-- Done. Next: run supabase/seed-to-supabase.mjs to load db_seed.json,
-- then promote yourself:
--   update profiles set role = 'admin' where email = 'you@example.com';
-- =========================================================
