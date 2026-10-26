import { useEffect, useState } from 'react';
import { ACTIVE_CLAIM_STATES, api, errorBody, type ClaimView } from './api';

export type StoredClaim = { claimId: string; claimToken: string };

const LABEL: Record<ClaimView['state'], string> = {
  open: 'Waiting for owner',
  owner_confirmed: 'Owner confirmed',
  both_live: 'Both live',
  challenged: 'Joint check',
  resolved: 'Resolved',
  review: 'Manual review',
  expired: 'Expired',
  cancelled: 'Cancelled',
};

/** The claimant's view of their claim. Polls while the claim is active. */
export function ClaimStatus({ stored, onDone }: { stored: StoredClaim; onDone: () => void }) {
  const [claim, setClaim] = useState<ClaimView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stop = false;
    const load = () =>
      api
        .claimAsClaimant(stored.claimId, stored.claimToken)
        .then((r) => !stop && setClaim(r.claim))
        .catch((e) => !stop && setError(errorBody(e).message));
    load();
    const timer = setInterval(load, 4000);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [stored]);

  async function cancel() {
    try {
      setClaim((await api.cancelClaim(stored.claimId, stored.claimToken)).claim);
    } catch (e) {
      setError(errorBody(e).message);
    }
  }

  if (error) {
    return (
      <section className="card error">
        <h2>Your claim</h2>
        <p>{error}</p>
        <button onClick={onDone}>Dismiss</button>
      </section>
    );
  }
  if (!claim) return <p className="muted">Loading claim...</p>;

  const active = ACTIVE_CLAIM_STATES.includes(claim.state);
  return (
    <section className={`card ${active ? 'warn' : claim.state === 'resolved' ? 'ok' : ''}`}>
      <h2>
        Your claim <span className="badge">{LABEL[claim.state]}</span>
      </h2>
      <p>{claim.nextStep}</p>
      <dl>
        <dt>Claim</dt>
        <dd><code>{claim.id}</code></dd>
        <dt>Your name</dt>
        <dd>{claim.claimantName}</dd>
        {active && (
          <>
            <dt>Expires</dt>
            <dd>{new Date(claim.expiresAt).toLocaleString()}</dd>
          </>
        )}
      </dl>
      {claim.state === 'open' && (
        <p className="muted">
          The person this face matched must log in on this app and confirm with their recovery code. Keep this
          page open; it updates by itself.
        </p>
      )}
      <div className="row">
        {active ? (
          <button className="secondary" onClick={cancel}>Cancel claim</button>
        ) : (
          <button onClick={onDone}>Dismiss</button>
        )}
      </div>
    </section>
  );
}
