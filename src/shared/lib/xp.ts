import { Rank, RANK_ORDER, XP_PER_LEVEL, MAX_LEVEL } from '../types'

export function xpToNextLevel(currentXp: number): number {
  return XP_PER_LEVEL - (currentXp % XP_PER_LEVEL)
}

export function levelFromXp(totalXp: number): number {
  return Math.floor(totalXp / XP_PER_LEVEL) + 1
}

export function xpProgressPercent(currentXp: number): number {
  return ((currentXp % XP_PER_LEVEL) / XP_PER_LEVEL) * 100
}

export function canPromote(rank: Rank, level: number): boolean {
  const maxLevel = MAX_LEVEL[rank]
  const rankIndex = RANK_ORDER.indexOf(rank)
  return level >= maxLevel && rankIndex < RANK_ORDER.length - 1
}

export function nextRank(rank: Rank): Rank | null {
  const idx = RANK_ORDER.indexOf(rank)
  return idx < RANK_ORDER.length - 1 ? RANK_ORDER[idx + 1] : null
}
