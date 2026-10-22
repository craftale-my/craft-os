import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../../../index.css'
import { assertDevDatabase } from './guard'
import PosSpike from './PosSpike'

assertDevDatabase(import.meta.env.VITE_SUPABASE_URL as string)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PosSpike />
  </StrictMode>,
)
