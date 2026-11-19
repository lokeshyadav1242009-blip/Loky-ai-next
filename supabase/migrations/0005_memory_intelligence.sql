-- =============================================================================
-- LOKY MEMORY — memory intelligence fields
-- =============================================================================
-- Additive migration on top of 0004_loky_memory.sql. It ONLY adds columns,
-- constraints and one index to public.memories. Nothing is dropped, truncated
-- or rewritten, and no policy is altered: the existing user_id = auth.uid()
-- policies remain the access boundary, and RLS stays enabled.
--
-- Why these fields:
--   importance                how much a note matters in a future chat (0..1)
--   confidence                how sure the extractor was (0..1)
--   source_conversation_id    which chat the fact came from (client id, opaque)
--
-- Every column has a default, so existing rows stay valid and the server keeps
-- working if this migration has not been applied yet — it detects the missing
-- columns and falls back to the 0004 column set.
--
-- Idempotent: safe to re-run. Apply in the Supabase SQL editor.
-- =============================================================================

begin;

alter table public.memories
  add column if not exists importance numeric(3, 2) not null default 0.50,
  add column if not exists confidence numeric(3, 2) not null default 0.60,
  add column if not exists source_conversation_id text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'memories_importance_range_check'
  ) then
    alter table public.memories
      add constraint memories_importance_range_check
      check (importance >= 0 and importance <= 1);
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'memories_confidence_range_check'
  ) then
    alter table public.memories
      add constraint memories_confidence_range_check
      check (confidence >= 0 and confidence <= 1);
  end if;

  -- Opaque client conversation ids only: bounded, and no path or query syntax.
  if not exists (
    select 1 from pg_constraint where conname = 'memories_source_conversation_check'
  ) then
    alter table public.memories
      add constraint memories_source_conversation_check
      check (
        source_conversation_id is null
        or source_conversation_id ~ '^[A-Za-z0-9_-]{1,64}$'
      );
  end if;
end
$$;

-- Ranking for the chat-time baseline reads importance before recency.
create index if not exists memories_user_importance_idx
  on public.memories (user_id, importance desc, updated_at desc);

commit;

-- =============================================================================
-- Post-apply self-check (read-only)
-- =============================================================================
select
  (select count(*) from information_schema.columns
     where table_schema = 'public' and table_name = 'memories'
       and column_name in ('importance', 'confidence', 'source_conversation_id')) as new_columns,
  (select relrowsecurity from pg_class where oid = 'public.memories'::regclass) as memories_rls,
  (select count(*) from pg_policies
     where schemaname = 'public' and tablename = 'memories') as memories_policies;
