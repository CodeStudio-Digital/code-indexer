import './index.css';
import { StrictMode } from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App.js';
import { AuthProvider } from './lib/auth.js';
import { ConfirmHost } from './lib/confirm.js';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <App />
        <ConfirmHost />
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
