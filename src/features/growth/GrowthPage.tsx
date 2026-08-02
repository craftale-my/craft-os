import { MissionsPage } from '../missions/Missions'

// ─── Page (mission-library management only) ───────────────────────────────────

export default function GrowthPage() {
  return (
    <div className="min-h-screen bg-cream-light">
      <div className="max-w-3xl mx-auto px-4 py-8 lg:px-8 space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-brown-dark">Missions</h1>
          <p className="text-sm text-brown-faint mt-0.5">
            Manage the mission library — create, edit, and retire missions.
          </p>
        </div>

        <MissionsPage />
      </div>
    </div>
  )
}
