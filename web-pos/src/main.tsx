import React from 'react';
import ReactDOM from 'react-dom/client';
import { WebPosApp } from './WebPosApp.tsx';
import './estilos_web_pos.css';

const rootEl = document.getElementById('root-web-pos');
if (rootEl) {
  ReactDOM.createRoot(rootEl).render(
    <React.StrictMode>
      <WebPosApp />
    </React.StrictMode>
  );
}
