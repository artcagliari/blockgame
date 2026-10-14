import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { enableAutoUpdate } from './game/auto-update';
import './styles.css';

enableAutoUpdate();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
