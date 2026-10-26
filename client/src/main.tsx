import '@aws-amplify/ui-react/styles.css';
import './styles.css';
import { ThemeProvider } from '@aws-amplify/ui-react';
import { Amplify } from 'aws-amplify';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { api } from './api';
import { App } from './App';

const root = createRoot(document.getElementById('root')!);

// Identity pool comes from the backend (which reads infra/cdk-outputs.json).
api
  .config()
  .then(({ region, identityPoolId }) => {
    if (!identityPoolId) throw new Error('No IdentityPoolId: deploy infra first');
    Amplify.configure({ Auth: { Cognito: { identityPoolId, allowGuestAccess: true } } });
    root.render(
      <StrictMode>
        <ThemeProvider>
          <App region={region} />
        </ThemeProvider>
      </StrictMode>,
    );
  })
  .catch((e: Error) => {
    root.render(<p style={{ padding: 24 }}>Cannot reach the server: {e.message}. Is `npm run server:dev` running?</p>);
  });
