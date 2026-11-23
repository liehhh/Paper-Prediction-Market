-- Player profile pictures. Owner: services/trading (the picture belongs to the player's country).
-- Additive only: existing accounts, balances, positions and public links are untouched; every account simply has no
-- picture (NULL) until its player picks one, and keeps its permanent colour.

alter table trading.accounts
  -- The object name inside the public `avatars` bucket: "<random uuid>.webp". A NEW name on every change, so browsers and
  -- CDNs can never show a stale picture. The full object path is "<country_id>/<avatar_key>".
  add column avatar_key text,
  add constraint accounts_avatar_key_format check (
    avatar_key is null or avatar_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.webp$'
  );

-- ---------------------------------------------------------------------------------------------
-- Supabase Storage. Applied only where Storage exists (hosted Supabase); the plain throwaway test database
-- has no `storage` schema, so this block is skipped there (the tests simulate it to check the policies).
-- ---------------------------------------------------------------------------------------------
do $storage$
begin
  if to_regnamespace('storage') is null then
    return;
  end if;

  -- Does the signed-in user own this country? The Storage policies below ask this about the first folder of an
  -- object's path, which is the country id. SECURITY DEFINER so the browser-facing role can answer it without
  -- being given any access to the trading tables themselves.
  create or replace function trading.owns_country(country text) returns boolean
  language sql stable security definer set search_path = ''
  as $fn$
    select exists (
      select 1 from trading.accounts a
       where a.user_id = (select auth.uid()) and a.country_id::text = country
    )
  $fn$;

  revoke all on function trading.owns_country(text) from public;
  -- USAGE on the schema only lets the role call this one function. The tables stay unreachable
  -- (no grants, RLS on) and the schema is not exposed through the Data API.
  grant usage on schema trading to authenticated;
  grant execute on function trading.owns_country(text) to authenticated;

  -- Public-read bucket. Storage itself enforces the limits: at most 256 KB per object, WebP only.
  -- (services/api re-encodes every upload to a 256 px WebP long before it gets here; these are the backstop.)
  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('avatars', 'avatars', true, 262144, array['image/webp'])
  on conflict (id) do update
    set public = true, file_size_limit = 262144, allowed_mime_types = array['image/webp'];

  -- Writes only inside the caller's OWN country folder. There is deliberately no UPDATE policy: an object can be
  -- created or deleted, never overwritten, so replacing a picture always means a new object name.
  drop policy if exists avatars_insert_own_country on storage.objects;
  create policy avatars_insert_own_country on storage.objects for insert to authenticated
    with check (bucket_id = 'avatars' and trading.owns_country((storage.foldername(name))[1]));

  drop policy if exists avatars_delete_own_country on storage.objects;
  create policy avatars_delete_own_country on storage.objects for delete to authenticated
    using (bucket_id = 'avatars' and trading.owns_country((storage.foldername(name))[1]));

  -- Storage reads the row it is deleting. Reading the public picture itself needs no policy (public bucket).
  drop policy if exists avatars_select_own_country on storage.objects;
  create policy avatars_select_own_country on storage.objects for select to authenticated
    using (bucket_id = 'avatars' and trading.owns_country((storage.foldername(name))[1]));
end
$storage$;
