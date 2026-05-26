import React from 'react';
import { createRoot } from 'react-dom/client';
import { ApiConfig } from './components/ApiConfig';

const container = document.getElementById('root');
if (container) {
  const root = createRoot(container);
  root.render(
    <React.StrictMode>
      <ApiConfig />
    </React.StrictMode>
  );
}
