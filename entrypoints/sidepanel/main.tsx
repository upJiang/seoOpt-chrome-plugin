import '@fontsource/nunito/latin-400.css';
import '@fontsource/nunito/latin-600.css';
import '@fontsource/nunito/latin-700.css';
import '@fontsource/fira-code/latin-400.css';
import '@fontsource/fira-code/latin-500.css';
import React from 'react';
import ReactDOM from 'react-dom/client';

import { App } from './App';
import './style.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
