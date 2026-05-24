import './i18n/index.js';
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.js';
import './index.css';
import { installFetchBase } from './lib/install-fetch-base.js';

// Rewrites `/api/*` and `/ws/*` to the absolute backend URL when running
// inside Electron. No-op in browser dev. Must run before any component
// fires a fetch.
installFetchBase();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
