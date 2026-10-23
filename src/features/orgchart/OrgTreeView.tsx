import { ChevronDown, ChevronRight } from 'lucide-react'
import { Avatar } from '../../shared/components/Avatar'
import { RankBadge } from '../../shared/components/RankBadge'
import { shortenBranch } from '../../shared/lib/branches'
import type { OrgPerson, OrgTree } from './orgTree'

export interface TreeCtx {
  tree: OrgTree
  expanded: Set<string>
  onToggle: (id: string) => void
  meId: string | null
  chainIds: Set<string>
  highlightId: string | null
  /** Set for managers: clicking a name opens the profile. */
  onOpen?: (id: string) => void
}

export function OrgTreeView({ roots, ctx }: { roots: OrgPerson[]; ctx: TreeCtx }) {
  if (roots.length === 0) return null
  return (
    <div className="org-tree">
      <ul>
        {roots.map(r => <OrgNode key={r.id} person={r} ctx={ctx} ancestors={new Set()} />)}
      </ul>
    </div>
  )
}

function OrgNode({ person, ctx, ancestors }: { person: OrgPerson; ctx: TreeCtx; ancestors: Set<string> }) {
  // `ancestors` guards against a loop in old data rendering forever.
  const kids = ctx.tree.childrenOf(person.id).filter(k => !ancestors.has(k.id))
  const isOpen = ctx.expanded.has(person.id)
  const isMe = person.id === ctx.meId
  const border =
    ctx.highlightId === person.id ? 'border-accent ring-2 ring-accent/40'
    : isMe ? 'border-accent'
    : ctx.chainIds.has(person.id) ? 'border-accent/40'
    : 'border-transparent'
  const nextAncestors = new Set(ancestors).add(person.id)

  return (
    <li>
      <div
        id={`org-node-${person.id}`}
        data-testid={`org-card-${person.id}`}
        className={`w-44 rounded-xl border bg-white shadow-card px-3 py-2.5 text-left transition-shadow ${border}`}
      >
        <div className="flex items-center gap-2">
          <Avatar name={person.name} avatar={person.avatar} size="sm" />
          <div className="min-w-0">
            {ctx.onOpen ? (
              <button
                type="button"
                onClick={() => ctx.onOpen!(person.id)}
                className="block max-w-full truncate text-sm font-semibold text-brown-dark hover:underline"
              >
                {person.name}
              </button>
            ) : (
              <p className="truncate text-sm font-semibold text-brown-dark">{person.name}</p>
            )}
            {person.nickname && <p className="truncate text-xs text-brown-muted">({person.nickname})</p>}
          </div>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-1">
          <RankBadge rank={person.rank} size="sm" />
          {isMe && <span className="rounded-full bg-accent px-2 py-0.5 text-[11px] font-semibold text-white">You</span>}
        </div>
        {person.job_title && <p className="mt-1 truncate text-xs text-brown-dark">{person.job_title}</p>}
        <p className="text-xs text-brown-muted">{shortenBranch(person.branch)}</p>
        {kids.length > 0 && (
          <button
            type="button"
            onClick={() => ctx.onToggle(person.id)}
            aria-expanded={isOpen}
            aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${person.name}'s team`}
            className="mt-1.5 inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-xs font-medium text-accent-text hover:bg-cream"
          >
            {isOpen ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />}
            {kids.length}
          </button>
        )}
      </div>
      {kids.length > 0 && isOpen && (
        <ul>
          {kids.map(k => <OrgNode key={k.id} person={k} ctx={ctx} ancestors={nextAncestors} />)}
        </ul>
      )}
    </li>
  )
}
