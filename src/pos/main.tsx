import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../index.css'
import PosApp from './PosApp'
import { RUNNING_BUILD, swUrl } from './appUpdate'

// The service worker only in a build: in `npm run dev:pos` it would cache the dev server.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  void navigator.serviceWorker.register(swUrl(RUNNING_BUILD))
}

createRoot(document.getElementById('root')!).render(<StrictMode><PosApp /></StrictMode>)
