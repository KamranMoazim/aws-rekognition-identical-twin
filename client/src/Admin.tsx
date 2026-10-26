import { useState } from 'react';
import { api, errorBody, type ReviewItem } from './api';
import { store } from './storage';

const REASON: Record<string, string> = {
  owner_declined: 'The account owner said they do not know the claimant.',
  co_presence_failed: 'The joint camera check failed 3 times.',
  too_many_claims: 'Too many failed claims against this account in 30 days.',
};

/**
 * Review queue (open http://localhost:5173/#admin). The one place a human
 * decides. A reviewer never creates an identity: reject closes the claim,
 * reopen gives it one more automatic attempt that still needs co-presence.
 */
export function Admin() {
  const [token, setToken] = useState(() => store.get<string>('twin.admin') ?? '');
  const [items, setItems] = useState<ReviewItem[] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  async function load(t = token) {
    setMsg(null);
    try {
      setItems((await api.reviewQueue(t)).items);
      store.set('twin.admin', t);
    } catch (e) {
      setItems(null);
      setMsg(errorBody(e).message);
    }
  }

  async function decide(id: string, decision: 'reject' | 'reopen') {
    try {
      const r = await api.decide(id, decision, token);
      setMsg(`Claim ${id.slice(0, 8)}: ${decision === 'reject' ? 'rejected' : `reopened (now ${r.claim.state})`}.`);
      load();
    } catch (e) {
      setMsg(errorBody(e).message);
    }
  }

  return (
    <main>
      <header>
        <h1>Review queue</h1>
        <p className="muted">
          Claims that automation could not settle. <a href="#">Back to the app</a>
        </p>
      </header>
      <form
        className="card row"
        onSubmit={(e) => {
          e.preventDefault();
          load();
        }}
      >
        <input type="password" placeholder="ADMIN_TOKEN from server/.env" value={token} onChange={(e) => setToken(e.target.value)} />
        <button type="submit" disabled={!token}>Load</button>
      </form>
      {msg && <p className="muted">{msg}</p>}
      {items && items.length === 0 && <p className="card">Nothing to review.</p>}
      {items?.map((i) => (
        <section key={i.claim.id} className="card warn">
          <h2>
            {i.claim.claimantName} <span className="badge">{i.claim.reviewReason}</span>
          </h2>
          <p>{REASON[i.claim.reviewReason ?? ''] ?? 'Sent to review.'}</p>
          <dl>
            <dt>Claim</dt>
            <dd><code>{i.claim.id}</code></dd>
            <dt>Against</dt>
            <dd>{i.members.map((m) => m.displayName).join(', ')}{i.claim.targetGroupId ? ' (collision group)' : ''}</dd>
            <dt>Owners confirmed</dt>
            <dd>{i.confirmations} of {i.members.length}</dd>
            <dt>Joint attempts</dt>
            <dd>{i.claim.attemptCount}</dd>
            <dt>Opened</dt>
            <dd>{new Date(i.claim.createdAt).toLocaleString()}</dd>
          </dl>
          <details>
            <summary>Audit trail ({i.events.length})</summary>
            <div className="events">
              {i.events.map((e, n) => (
                <div key={n}>
                  {new Date(e.at).toLocaleTimeString()} {e.type} {e.data ? JSON.stringify(e.data) : ''}
                </div>
              ))}
            </div>
          </details>
          <div className="row">
            <button className="secondary" onClick={() => decide(i.claim.id, 'reject')}>Reject (close)</button>
            <button onClick={() => decide(i.claim.id, 'reopen')}>Reopen (one more automatic try)</button>
          </div>
        </section>
      ))}
    </main>
  );
}
