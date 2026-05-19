import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import StormScope from './StormScope';
import { initAgents } from './agents';

initAgents(import.meta.env.VITE_OPENAI_API_KEY || '');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <StormScope />
  </StrictMode>,
);
