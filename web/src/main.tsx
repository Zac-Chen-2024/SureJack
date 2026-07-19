import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { logBuildInfo } from './build-info'
import './index.css'
import App from './App.tsx'

// 开机就把版本打出来：线上排查第一件事是确认「跑的是哪一版」
logBuildInfo()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
