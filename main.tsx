import { Buffer } from 'buffer'
// @ts-expect-error polyfill Buffer
globalThis.Buffer = globalThis.Buffer || Buffer
// @ts-expect-error polyfill global
globalThis.global = globalThis.global || globalThis

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
