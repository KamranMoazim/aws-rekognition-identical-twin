-- Full schema for the twin collision resolver (see build plan, "Data model").
-- Rekognition stores only face vectors; every decision lives here.

-- One row per real person.
create table identities (
  id           uuid primary key default gen_random_uuid(),
  display_name text not null,
  status       text not null default 'active' check (status in ('active', 'locked')),
  created_at   timestamptz not null default now()
);

-- Every face indexed in Rekognition belongs to exactly one identity.
create table faces (
  rekognition_face_id text primary key,
  identity_id         uuid not null references identities(id),
  source              text not null check (source in ('registration', 'co_presence')),
  created_at          timestamptz not null default now()
);
create index faces_identity_idx on faces(identity_id);

-- Lookalikes who proved they are different people.
create table collision_groups (
  id         uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now()
);

-- identity_id is the PK: an identity is in at most one group.
create table group_members (
  identity_id uuid primary key references identities(id),
  group_id    uuid not null references collision_groups(id),
  joined_at   timestamptz not null default now()
);
create index group_members_group_idx on group_members(group_id);

-- A "this is not my account" claim and its progress.
create table claims (
  id                   uuid primary key default gen_random_uuid(),
  target_identity_id   uuid not null references identities(id),
  claimant_name        text not null,
  state                text not null check (state in (
                         'open', 'owner_confirmed', 'both_live', 'challenged',
                         'resolved', 'review', 'expired', 'cancelled')),
  challenge            jsonb,
  challenge_expires_at timestamptz,
  expires_at           timestamptz not null,
  attempt_count        int not null default 0,
  result_identity_id   uuid references identities(id),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
-- At most one in-progress claim per target identity.
create unique index claims_one_open_per_target on claims(target_identity_id)
  where state in ('open', 'owner_confirmed', 'both_live', 'challenged');

-- Secrets are hashes only. Lockout fields are per identity.
create table credentials (
  identity_id        uuid primary key references identities(id),
  pin_hash           text,
  recovery_code_hash text not null,
  failed_attempts    int not null default 0,
  locked_until       timestamptz
);

-- Each liveness session counts once, then it is spent.
create table liveness_sessions (
  session_id text primary key,
  purpose    text not null check (purpose in ('register', 'login', 'claim', 'recovery')),
  claim_id   uuid references claims(id),
  role       text check (role in ('owner', 'claimant')),
  confidence real,
  used       boolean not null default false,
  created_at timestamptz not null default now()
);

-- Failed PIN attempts against a whole group (throttle, never lock a member).
create table group_login_attempts (
  id       bigserial primary key,
  group_id uuid not null references collision_groups(id),
  at       timestamptz not null default now()
);
create index group_login_attempts_idx on group_login_attempts(group_id, at);

-- Every claim step is traceable.
create table audit_events (
  id          bigserial primary key,
  type        text not null,
  identity_id uuid,
  claim_id    uuid,
  data        jsonb,
  at          timestamptz not null default now()
);
create index audit_events_claim_idx on audit_events(claim_id);
