import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { ClerkProvider } from '@clerk/clerk-react'
import Router from './Router'
import './index.css'

const CLERK_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY
if (!CLERK_KEY) throw new Error('VITE_CLERK_PUBLISHABLE_KEY not set in .env')

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ClerkProvider publishableKey={CLERK_KEY} afterSignOutUrl="/">
      <BrowserRouter>
        <Router />
      </BrowserRouter>
    </ClerkProvider>
  </React.StrictMode>
)
