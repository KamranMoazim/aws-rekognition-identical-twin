-- Step 4: a claim liveness session only counts once its face matched the claimed identity.
alter table liveness_sessions add column passed boolean not null default false;
create index liveness_sessions_claim_idx on liveness_sessions(claim_id) where claim_id is not null;
