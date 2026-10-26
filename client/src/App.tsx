import { useEffect, useState } from 'react';
import { api, errorBody, type ApiError, type Identity } from './api';
import { ClaimStatus, type StoredClaim } from './ClaimStatus';
import { Liveness } from './Liveness';
import { OwnerClaims } from './OwnerClaims';
import { store } from './storage';

type View =
  | { name: 'home' }
  | { name: 'register-form' }
  | { name: 'register-liveness'; displayName: string }
  | { name: 'login-liveness' }
  | { name: 'working'; label: string }
  | { name: 'registered'; identity: Identity; recoveryCode: string }
  | { name: 'match'; topSimilarity: number; matchToken: string; displayName: string }
  | { name: 'error'; error: ApiError };

const TOKEN_KEY = 'twin.sessionToken';
const CLAIM_KEY = 'twin.claim';

export function App({ region }: { region: string }) {
  const [view, setView] = useState<View>({ name: 'home' });
  const [token, setToken] = useState<string | null>(() => store.get<string>(TOKEN_KEY));
  // Persistent: closing the window must not orphan a claim (it would block new claims for 24 h).
  const [claim, setClaim] = useState<StoredClaim | null>(() => store.get<StoredClaim>(CLAIM_KEY, true));
  const [me, setMe] = useState<Identity | null>(null);
  const [name, setName] = useState('');

  useEffect(() => {
    if (!token) return setMe(null);
    api
      .me(token)
      .then((r) => setMe(r.identity))
      .catch(() => signOut());
  }, [token]);

  function signIn(newToken: string) {
    store.set(TOKEN_KEY, newToken);
    setToken(newToken);
  }
  function signOut() {
    store.set(TOKEN_KEY, null);
    setToken(null);
    setView({ name: 'home' });
  }
  function keepClaim(c: StoredClaim | null) {
    store.set(CLAIM_KEY, c, true);
    setClaim(c);
  }

  async function finishRegister(sessionId: string, displayName: string) {
    setView({ name: 'working', label: 'Checking your face against existing identities...' });
    try {
      const r = await api.register(sessionId, displayName);
      signIn(r.sessionToken);
      setView({ name: 'registered', identity: r.identity, recoveryCode: r.recoveryCode });
    } catch (err) {
      const body = errorBody(err);
      if (typeof body.matchToken !== 'string') return setView({ name: 'error', error: body });
      setView({ name: 'match', topSimilarity: Number(body.topSimilarity), matchToken: body.matchToken, displayName });
    }
  }

  async function finishLogin(sessionId: string) {
    setView({ name: 'working', label: 'Looking you up...' });
    try {
      const r = await api.login(sessionId);
      signIn(r.sessionToken);
      setView({ name: 'home' });
    } catch (err) {
      setView({ name: 'error', error: errorBody(err) });
    }
  }

  async function startClaim(matchToken: string, claimantName: string) {
    setView({ name: 'working', label: 'Opening your claim...' });
    try {
      const r = await api.openClaim(matchToken, claimantName);
      keepClaim({ claimId: r.claim.id, claimToken: r.claimToken });
      setView({ name: 'home' });
    } catch (err) {
      setView({ name: 'error', error: errorBody(err) });
    }
  }

  return (
    <main>
      <header>
        <h1>Twin Resolver</h1>
        <p className="muted">Step 3: claims ("this is not me"), owner confirm, expiry</p>
      </header>

      {claim && <ClaimStatus stored={claim} onDone={() => keepClaim(null)} />}

      {me && token && (
        <>
          <section className="card ok">
            <h2>Signed in as {me.displayName}</h2>
            <dl>
              <dt>Identity</dt>
              <dd><code>{me.id}</code></dd>
              <dt>Collision group</dt>
              <dd>{me.groupId ? <code>{me.groupId}</code> : 'none'}</dd>
              <dt>Created</dt>
              <dd>{new Date(me.createdAt).toLocaleString()}</dd>
            </dl>
            <button onClick={signOut}>Sign out</button>
          </section>
          <OwnerClaims token={token} />
        </>
      )}

      {view.name === 'home' && !me && (
        <section className="card">
          <div className="row">
            <button onClick={() => setView({ name: 'register-form' })}>Register</button>
            <button onClick={() => setView({ name: 'login-liveness' })}>Log in with face</button>
          </div>
        </section>
      )}

      {view.name === 'register-form' && (
        <form
          className="card"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) setView({ name: 'register-liveness', displayName: name.trim() });
          }}
        >
          <label>
            Your name
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoFocus />
          </label>
          <div className="row">
            <button type="submit" disabled={!name.trim()}>Continue to face check</button>
            <button type="button" className="secondary" onClick={() => setView({ name: 'home' })}>Cancel</button>
          </div>
        </form>
      )}

      {view.name === 'register-liveness' && (
        <Liveness
          purpose="register"
          region={region}
          onComplete={(id) => finishRegister(id, view.displayName)}
          onCancel={() => setView({ name: 'home' })}
        />
      )}

      {view.name === 'login-liveness' && (
        <Liveness purpose="login" region={region} onComplete={finishLogin} onCancel={() => setView({ name: 'home' })} />
      )}

      {view.name === 'working' && <p className="muted">{view.label}</p>}

      {view.name === 'registered' && (
        <section className="card ok">
          <h2>Identity created</h2>
          <p>Save your recovery code. It is shown only once. You need it to confirm a claim or reset a PIN later.</p>
          <p className="code">{view.recoveryCode}</p>
          <button onClick={() => setView({ name: 'home' })}>I saved it</button>
        </section>
      )}

      {view.name === 'match' && (
        <section className="card warn">
          <h2>This face is already registered</h2>
          <p>
            Your face matches an existing identity (similarity {view.topSimilarity}%). No new identity was created.
          </p>
          <p className="muted">
            If that account is not yours (for example you have an identical twin), open a claim. The account owner
            must confirm it, then you both do a joint camera check.
          </p>
          <div className="row">
            <button onClick={() => startClaim(view.matchToken, view.displayName)} disabled={!!claim}>
              This is not me, open a claim
            </button>
            <button className="secondary" onClick={() => setView({ name: 'login-liveness' })}>It is me, log in</button>
          </div>
          {claim && <p className="muted">You already have a claim in progress.</p>}
        </section>
      )}

      {view.name === 'error' && (
        <section className="card error">
          <h2>{view.error.error}</h2>
          <p>{view.error.message}</p>
          {typeof view.error.expiresAt === 'string' && (
            <p className="muted">Expires {new Date(view.error.expiresAt).toLocaleString()}</p>
          )}
          <button onClick={() => setView({ name: 'home' })}>Back</button>
        </section>
      )}
    </main>
  );
}
