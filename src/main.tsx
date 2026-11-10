import { createRoot } from 'react-dom/client'
import App from './App'
import { applyLanguage } from './i18n'
import { getSettings, subscribeSettings } from './lib/settings'
import './styles.css'

// Before the first render, then on every change of the language setting.
applyLanguage(getSettings().language)
subscribeSettings(() => applyLanguage(getSettings().language))

createRoot(document.getElementById('root')!).render(<App />)
