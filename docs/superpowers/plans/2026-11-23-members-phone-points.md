# Members: phone sign-in and points — implementation plan

Spec: `docs/superpowers/specs/2026-11-22-members-phone-points-design.md`. Built by one subagent per task,
each reviewed before the next; dev database only (`egznnbjmicebbhwasloy`); every task ends green on
`npx tsc -b`, `npm test`, `npm run build`. Each task's brief is `.superpowers/sdd/task-<n>-brief.md`.

| Task | Delivers | Done when |
|---|---|---|
| 15 SQL | `supabase/migration-2026-11-23-members.sql` + verify: tables, RLS, `bills.member_id`, triggers (earn on paid, refund, merge hand-over, split part inherits), RPCs `member_me`, `member_sign_out`, `member_link_table`, `pos_bill_set_member`, `pos_bill_clear_member`, `member_search`, `member_ledger`, `member_adjust`, `member_delete`, `member_settings_get/set`, service-only `member_otp_*` helpers for the function | verify prints VERIFY OK on dev; W4/QR-cart verify scripts still OK |
| 16 Edge Function | `supabase/functions/member-auth` (`/request`, `/verify`), provider interface, `log` adapter, limits, no enumeration; deployed to dev; deno tests | curl walk on dev: request → dev code read by SQL → verify → token → `member_me` |
| 17 QR | `src/qr/member/` (`phone.ts`, `memberApi.ts`, `useMember.ts`, `MemberSheet.tsx`), top-strip button, link after send and on entry | browser walk on dev: join with a dev code, balance shown, second guest sees whose number earns |
| 18 POS | `Member` bill action + dialog, bill column line, receipt lines (`Member ••6789`, `Points earned n`) | browser walk on dev with a paired device session; pay → points in ledger; refund → negative row |
| 19 Back office | `Members` page (search, list, ledger, Adjust points for owner), settings (rate, QR switch, SMS daily cap) | browser walk on dev |
| 20 SMS adapter | the real provider behind `sendSms` | waits for the owner's provider account |

Order: 15 → 16 → 17 → 18 → 19. 17–19 touch different folders but share the worktree, so they run one
after another. Rollout later: SQL → function + secrets → back office → POS → QR.
