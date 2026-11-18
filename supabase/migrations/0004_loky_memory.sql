-- =============================================================================
-- LOKY MEMORY — persistent, per-user AI memory
-- =============================================================================
-- Additive migration. Creates two new tables and nothing else:
--
--   public.memories         one row per remembered fact / preference / project
--   public.memory_settings  one row per user holding the ON/OFF switch
--
-- It does NOT touch profiles, conversations, messages, friendships, admin
-- tables or any existing policy. Nothing is dropped, truncated or rewritten.
--
-- Security model
--   * RLS is enabled on both tables and every policy pins user_id = auth.uid(),
--     so PostgREST can never return or mutate another account's rows.
--   * The browser only ever holds the publishable/anon key, and every request
--     the app makes carries the user's own access token, so RLS is the
--     authority — not a frontend check.
--   * `anon` gets no privileges at all: signed-out visitors cannot read or
--     write memory, and the table is not part of the public API surface.
--
-- Privacy
--   * `content` is plain text the user can read, edit and delete at any time.
--   * The server refuses to store anything that looks like a credential
--     (API keys, JWTs, passwords, private keys) before it reaches this table;
--     the CHECK constraints below only bound size and category.
--
-- Idempotent: safe to re-run. Apply in the Supabase SQL editor.
-- =============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. memories
-- ---------------------------------------------------------------------------

create table if not exists public.memories (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  category   text not null default 'personal',
  content    text not null,
  -- 'manual' = typed by the user, 'auto' = proposed by the assistant and
  -- confirmed by the user. Both are visible and editable in the Memory page.
  source     text not null default 'manual',
  pinned     boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Category and size guards mirror the server-side validation in
-- public/memory-model.js so the database rejects bad rows too.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'memories_category_check'
  ) then
    alter table public.memories
      add constraint memories_category_check
      check (category in ('personal', 'study', 'projects', 'preferences'));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'memories_content_len_check'
  ) then
    alter table public.memories
      add constraint memories_content_len_check
      check (char_length(btrim(content)) between 3 and 600);
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'memories_source_check'
  ) then
    alter table public.memories
      add constraint memories_source_check
      check (source in ('manual', 'auto'));
  end if;
end
$$;

-- Duplicate prevention lives in the database, not in the UI: the same text
-- cannot be stored twice for one user regardless of casing or stray spaces.
-- btrim() and lower() are both immutable, so this is a valid index expression.
create unique index if not exists memories_user_content_uniq
  on public.memories (user_id, lower(btrim(content)));

-- The chat route reads a user's memories newest-first.
create index if not exists memories_user_updated_idx
  on public.memories (user_id, updated_at desc);

-- Keep updated_at honest without trusting the client.
create or replace function public.touch_memories_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists memories_touch_updated_at on public.memories;
create trigger memories_touch_updated_at
  before update on public.memories
  for each row
  execute function public.touch_memories_updated_at();

alter table public.memories enable row level security;

drop policy if exists memories_select_own on public.memories;
create policy memories_select_own
  on public.memories for select
  to authenticated
  using (user_id = auth.uid());

drop policy if exists memories_insert_own on public.memories;
create policy memories_insert_own
  on public.memories for insert
  to authenticated
  with check (user_id = auth.uid());

drop policy if exists memories_update_own on public.memories;
create policy memories_update_own
  on public.memories for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists memories_delete_own on public.memories;
create policy memories_delete_own
  on public.memories for delete
  to authenticated
  using (user_id = auth.uid());

-- Least privilege: signed-in users only, and no sequence/trigger privileges.
revoke all on public.memories from anon;
grant select, insert, update, delete on public.memories to authenticated;

-- ---------------------------------------------------------------------------
-- 2. memory_settings — the Memory ON/OFF switch
-- ---------------------------------------------------------------------------
-- Kept separate from profiles so this migration never has to touch (or race
-- with) the existing profile write path and its policies.

create table if not exists public.memory_settings (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  enabled    boolean not null default true,
  updated_at timestamptz not null default now()
);

alter table public.memory_settings enable row level security;

drop policy if exists memory_settings_select_own on public.memory_settings;
create policy memory_settings_select_own
  on public.memory_settings for select
  to authenticated
  using (user_id = auth.uid());

drop policy if exists memory_settings_insert_own on public.memory_settings;
create policy memory_settings_insert_own
  on public.memory_settings for insert
  to authenticated
  with check (user_id = auth.uid());

drop policy if exists memory_settings_update_own on public.memory_settings;
create policy memory_settings_update_own
  on public.memory_settings for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

revoke all on public.memory_settings from anon;
grant select, insert, update on public.memory_settings to authenticated;

commit;

-- =============================================================================
-- Post-apply self-check (read-only; prints one row per assertion)
-- =============================================================================
select
  to_regclass('public.memories') is not null        as memories_table,
  to_regclass('public.memory_settings') is not null as memory_settings_table,
  (select relrowsecurity from pg_class where oid = 'public.memories'::regclass)        as memories_rls,
  (select relrowsecurity from pg_class where oid = 'public.memory_settings'::regclass) as settings_rls,
  (select count(*) from pg_policies
     where schemaname = 'public' and tablename = 'memories')        as memories_policies,
  (select count(*) from pg_policies
     where schemaname = 'public' and tablename = 'memory_settings') as settings_policies,
  (select count(*) from pg_indexes
     where schemaname = 'public' and indexname = 'memories_user_content_uniq') as dedupe_index;
