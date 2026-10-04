import React from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

const root = document.getElementById('root');

if (!root) {
  throw new Error('Root element is missing');
}

createRoot(root).render(
  <React.StrictMode>
    <main>
      <h1>{import.meta.env.VITE_APP_TITLE || 'Facility reporter'}</h1>
      <p>The reporter app is ready for confirmed requirements.</p>
    </main>
  </React.StrictMode>,
);
