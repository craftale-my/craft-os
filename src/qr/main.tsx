import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../index.css'
import QrApp from './QrApp'

createRoot(document.getElementById('root')!).render(<StrictMode><QrApp /></StrictMode>)
