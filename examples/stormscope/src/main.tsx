import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import StormScope from './StormScope';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <StormScope />
  </StrictMode>,
);
