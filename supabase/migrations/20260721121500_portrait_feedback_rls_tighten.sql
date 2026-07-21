-- Deny-all, totally. The prior revoke named only anon/authenticated; PUBLIC is a
-- separate grantee that a future `grant ... to public` or an inherited default
-- privilege would slip through. FORCE also subjects the table owner to the (empty)
-- policy set, so deny-all is total rather than "total for the roles we listed".
set local lock_timeout = '3s';

revoke all on public.playhub_portrait_render_feedback from public;
alter table public.playhub_portrait_render_feedback force row level security;
