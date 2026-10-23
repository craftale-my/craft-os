import type { ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import { Card, Badge } from '../../shared/components/ui'
import type { OrgPerson } from './orgTree'

/** "You → Direct → … → Owner" for the signed-in viewer. */
export function ReportingLine({ me, chain }: { me: OrgPerson | null; chain: OrgPerson[] }) {
  if (!me) return null
  let body: ReactNode
  if (me.system_role === 'owner') {
    body = <p className="text-sm text-brown-dark">You're at the top.</p>
  } else if (chain.length === 0) {
    body = <p className="text-sm text-brown-dark">You don't have a supervisor yet.</p>
  } else {
    body = (
      <ol aria-label="My reporting line" className="flex flex-wrap items-center gap-1.5 text-sm">
        <li className="font-semibold text-brown-dark">You</li>
        {chain.map((p, i) => (
          <li key={p.id} className="flex items-center gap-1.5">
            <ChevronRight size={14} className="text-brown-muted" aria-hidden />
            <span className="text-brown-dark">{p.name}</span>
            {i === 0 && <Badge tone="brand">Direct</Badge>}
          </li>
        ))}
      </ol>
    )
  }
  return (
    <Card className="mb-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-brown-muted mb-2">My reporting line</p>
      {body}
    </Card>
  )
}
