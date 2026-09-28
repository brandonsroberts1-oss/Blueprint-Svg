import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { ProjectProvider } from './state/store';
import { UIProvider } from './state/ui';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ProjectProvider>
      <UIProvider>
        <App />
      </UIProvider>
    </ProjectProvider>
  </StrictMode>,
);
