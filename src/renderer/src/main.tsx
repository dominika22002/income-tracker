import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { createCallableBackend } from './backend/callableBackend';
import { createFirebaseAuthGateway } from './backend/firebaseAuth';
import { createFirestoreDataSource } from './backend/firestoreData';
import type { AppServices } from './backend/ports';
import { auth, db, functions } from './firebase/config';
import './styles.css';

const services: AppServices = {
  auth: createFirebaseAuthGateway(auth, async () => {
    const result = await window.electronApi.startGoogleOAuth();
    if (!result.launched) {
      throw new Error(result.error ?? 'Could not open the system browser.');
    }
  }),
  backend: createCallableBackend(functions),
  data: createFirestoreDataSource(db),
};

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App services={services} />
  </React.StrictMode>,
);
