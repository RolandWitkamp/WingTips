-- WingTips — Supabase schema
-- Safe to run multiple times (idempotent) — run this in the Supabase SQL editor.
-- Backs up the client-side @klm.com check (src/App.tsx AuthScreen) with real server-side
-- enforcement: anyone calling the Supabase API directly, bypassing the app's own JS check,
-- gets rejected here too.

create or replace function handle_new_user() returns trigger as $$
begin
  if new.email !~* '@klm\.com$' then
    raise exception 'Only @klm.com e-mail addresses can create an account.';
  end if;
  return new;
end; $$ language plpgsql security definer;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created before insert on auth.users
  for each row execute procedure handle_new_user();

-- Dashboard changes needed too (can't be done via SQL):
-- Authentication -> Providers -> Email -> "Allow new users to sign up" ON, "Confirm email" ON.

-- Lets a signed-in user delete their own account (Profile -> Account -> Delete account) without
-- exposing the service-role key client-side: this function runs with elevated privileges
-- (security definer) but only ever deletes auth.uid()'s own row — a regular user only needs
-- EXECUTE on the function itself, nothing more.
create or replace function delete_own_account() returns void as $$
begin
  delete from auth.users where id = auth.uid();
end; $$ language plpgsql security definer;
grant execute on function delete_own_account() to authenticated;

-- ─── Cross-device sync ──────────────────────────────────────────────────────
-- Everything below used to live only in each browser's localStorage, so logging in on a
-- second device (or a new browser) started from scratch, and recommendations a crew member
-- added were never visible to anyone else -- only that one browser ever read them back.
-- These tables make it all real, shared, account-bound data.

-- One row per signed-in user: display profile plus small per-user UI state (which
-- destinations they've visited, which saved tips they've already seen) that doesn't
-- warrant its own table.
create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade
);
-- create table if not exists is a no-op when the table already exists, so if `profiles` was
-- created earlier (even just as a bare id column) with a since-updated version of this file,
-- the columns added later here never actually landed -- hence "PGRST204: could not find the
-- 'base' column" even though this script had "succeeded" every time it was run. Each column is
-- added individually and idempotently so the table is always brought up to the current shape
-- regardless of how or when it was first created.
alter table profiles add column if not exists name text not null default '';
alter table profiles add column if not exists role text not null default 'Cabin Crew';
alter table profiles add column if not exists base text not null default 'AMS';
alter table profiles add column if not exists bio text not null default '';
alter table profiles add column if not exists recent_destinations text[] not null default '{}';
alter table profiles add column if not exists favorites_seen text[] not null default '{}';
alter table profiles add column if not exists updated_at timestamptz not null default now();
-- This table turned out to predate this file, left over from an earlier approval-gated design
-- (approved/rejected/is_admin, same pattern as Pillow Report) that WingTips doesn't use -- those
-- three columns all have a false default so they don't block anything, but email is required with
-- no default, which rejected every insert that didn't set it. Not used by the app for anything
-- (crew tips show the display name, not the login email), so the simplest fix is to stop
-- requiring it rather than having every write carry it just to satisfy the column.
alter table profiles alter column email drop not null;
alter table profiles enable row level security;
drop policy if exists "profiles_select_own" on profiles;
create policy "profiles_select_own" on profiles for select using (auth.uid() = id);
drop policy if exists "profiles_insert_own" on profiles;
create policy "profiles_insert_own" on profiles for insert with check (auth.uid() = id);
drop policy if exists "profiles_update_own" on profiles;
create policy "profiles_update_own" on profiles for update using (auth.uid() = id);

-- Recommendations ("crew tips"): shared with every signed-in crew member, writable only by
-- their own author. author_name/author_role are copied from the profile at post time (same
-- display behaviour as before), so they don't need a join back to profiles to render.
create table if not exists recommendations (
  id bigint generated always as identity primary key,
  destination_code text not null,
  category text not null,
  author_id uuid not null references auth.users(id) on delete cascade,
  author_name text not null,
  author_role text not null,
  text text not null,
  price text,
  hours text,
  discount text,
  jetlag_proof boolean not null default false,
  solo_friendly boolean not null default false,
  tags text[],
  photo text,
  coords jsonb,
  created_at timestamptz not null default now()
);
alter table recommendations add column if not exists jetlag_proof boolean not null default false;
alter table recommendations add column if not exists solo_friendly boolean not null default false;
alter table recommendations enable row level security;
drop policy if exists "recommendations_select_all" on recommendations;
create policy "recommendations_select_all" on recommendations for select using (auth.role() = 'authenticated');
drop policy if exists "recommendations_insert_own" on recommendations;
create policy "recommendations_insert_own" on recommendations for insert with check (auth.uid() = author_id);
drop policy if exists "recommendations_delete_own" on recommendations;
create policy "recommendations_delete_own" on recommendations for delete using (auth.uid() = author_id);

create table if not exists recommendation_comments (
  id bigint generated always as identity primary key,
  recommendation_id bigint not null references recommendations(id) on delete cascade,
  author_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  role text not null,
  text text not null,
  created_at timestamptz not null default now()
);
alter table recommendation_comments enable row level security;
drop policy if exists "comments_select_all" on recommendation_comments;
create policy "comments_select_all" on recommendation_comments for select using (auth.role() = 'authenticated');
drop policy if exists "comments_insert_own" on recommendation_comments;
create policy "comments_insert_own" on recommendation_comments for insert with check (auth.uid() = author_id);

-- One row per (recommendation, user) so a like is a real toggle instead of an unbounded
-- "+1 on every tap" counter -- the count is just how many rows exist for that recommendation.
create table if not exists recommendation_likes (
  recommendation_id bigint not null references recommendations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (recommendation_id, user_id)
);
alter table recommendation_likes enable row level security;
drop policy if exists "likes_select_all" on recommendation_likes;
create policy "likes_select_all" on recommendation_likes for select using (auth.role() = 'authenticated');
drop policy if exists "likes_insert_own" on recommendation_likes;
create policy "likes_insert_own" on recommendation_likes for insert with check (auth.uid() = user_id);
drop policy if exists "likes_delete_own" on recommendation_likes;
create policy "likes_delete_own" on recommendation_likes for delete using (auth.uid() = user_id);

create table if not exists favorites (
  user_id uuid not null references auth.users(id) on delete cascade,
  tip_key text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, tip_key)
);
alter table favorites enable row level security;
drop policy if exists "favorites_select_own" on favorites;
create policy "favorites_select_own" on favorites for select using (auth.uid() = user_id);
drop policy if exists "favorites_insert_own" on favorites;
create policy "favorites_insert_own" on favorites for insert with check (auth.uid() = user_id);
drop policy if exists "favorites_delete_own" on favorites;
create policy "favorites_delete_own" on favorites for delete using (auth.uid() = user_id);

create table if not exists connections (
  user_id uuid not null references auth.users(id) on delete cascade,
  crew_name text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, crew_name)
);
alter table connections enable row level security;
drop policy if exists "connections_select_own" on connections;
create policy "connections_select_own" on connections for select using (auth.uid() = user_id);
drop policy if exists "connections_insert_own" on connections;
create policy "connections_insert_own" on connections for insert with check (auth.uid() = user_id);
drop policy if exists "connections_delete_own" on connections;
create policy "connections_delete_own" on connections for delete using (auth.uid() = user_id);

-- ─── AI Briefing ────────────────────────────────────────────────────────────
-- Cached per destination+category summary of that category's real crew tips, generated by the
-- generate-summary Edge Function (see supabase/functions/generate-summary). tip_count is the
-- number of recommendations the cached summary was generated from -- the function only
-- regenerates when that count has changed, so opening the same category repeatedly doesn't
-- re-call the AI every time. Clients only ever read this table; only the Edge Function (using the
-- service-role key, which bypasses RLS) writes to it, so there's no insert/update policy at all.
create table if not exists destination_summaries (
  destination_code text not null,
  category text not null,
  summary text not null,
  tip_count int not null default 0,
  updated_at timestamptz not null default now(),
  primary key (destination_code, category)
);
alter table destination_summaries enable row level security;
drop policy if exists "summaries_select_all" on destination_summaries;
create policy "summaries_select_all" on destination_summaries for select using (auth.role() = 'authenticated');
