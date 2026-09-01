-- ============================================================================
-- Late reason + notifications, schema only (2026-09-02). Idempotent.
-- ============================================================================

alter table staff add column if not exists supervisor_id uuid references staff(id) on delete set null;

alter table attendance add column if not exists late_reason_code text;
alter table attendance add column if not exists late_reason      text;
alter table attendance add column if not exists late_excused     boolean not null default false;
alter table attendance add column if not exists late_excused_by  uuid references staff(id);
alter table attendance add column if not exists late_excused_at  timestamptz;

do $$ begin
  alter table attendance add constraint attendance_late_reason_code_check
    check (late_reason_code is null or late_reason_code in
      ('traffic','transport','medical','work_errand','personal','other'));
exception when duplicate_object then null; end $$;

create table if not exists notifications (
  id               uuid primary key default gen_random_uuid(),
  recipient_id     uuid not null references staff(id) on delete cascade,
  event_type       text not null,
  title            text not null,
  body             text,
  link             text,
  subject_staff_id uuid references staff(id) on delete cascade,
  subject_date     date,
  read_at          timestamptz,
  created_at       timestamptz not null default now(),
  unique (recipient_id, event_type, subject_staff_id, subject_date)
);

create index if not exists notifications_inbox_idx
  on notifications (recipient_id, read_at, created_at desc);

alter table notifications enable row level security;

drop policy if exists "notifications_select_own" on notifications;
create policy "notifications_select_own" on notifications for select
  using (recipient_id = auth.uid());

-- Only the read flag is user-writable; the row itself is written by notify_late().
drop policy if exists "notifications_update_own_read" on notifications;
create policy "notifications_update_own_read" on notifications for update
  using (recipient_id = auth.uid()) with check (recipient_id = auth.uid());

-- Excusing is limited to the staff member's own supervisor and the manager tier.
drop policy if exists "attendance_update_excuse" on attendance;
create policy "attendance_update_excuse" on attendance for update
  using (
    exists (
      select 1 from staff me, staff t
      where me.id = auth.uid() and t.id = attendance.staff_id
        and (me.system_role in ('manager','admin','owner') or me.rank = 'manager'
             or t.supervisor_id = me.id)
    )
  );

insert into notification_settings (event_type, label, notify_staff, notify_supervisor, notify_manager)
values ('attendance_late', 'Late Arrival', true, true, false)
on conflict (event_type) do nothing;

insert into system_rules (key, value, label, description) values
  ('late_reason_written_threshold', '15', 'Late reason: written explanation above (min)',
   'Lateness above this many minutes requires a typed explanation, not just a reason code')
on conflict (key) do nothing;

do $$ begin
  alter publication supabase_realtime add table notifications;
exception when duplicate_object then null; end $$;
