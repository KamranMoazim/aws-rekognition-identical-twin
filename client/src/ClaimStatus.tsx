import { useEffect, useState } from 'react';
import { ACTIVE_CLAIM_STATES, api, errorBody, type ClaimView, type JointResult } from './api';
import { CoPresence, FaceTable } from './CoPresence';

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
type Props = {
  stored: StoredClaim;
  region: string;
  onSignedIn: (sessionToken: string) => void;
  onDone: () => void;
};

export function ClaimStatus({ stored, region, onSignedIn, onDone }: Props) {
  const [claim, setClaim] = useState<ClaimView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [passed, setPassed] = useState<Extract<JointResult, { result: 'pass' }> | null>(null);

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
  if (passed) {
    return (
      <section className="card ok">
        <h2>Two people proven. Your identity is created.</h2>
        <p>
          Welcome, <strong>{passed.identity.displayName}</strong>. You and the account owner are now a collision group:
          a face match finds the group, and your PIN (step 5) picks the right person.
        </p>
        <p>Save your recovery code. It is shown only once.</p>
        <p className="code">{passed.recoveryCode}</p>
        <FaceTable faces={passed.faces} />
        <div className="row">
          <button onClick={onDone}>I saved it</button>
        </div>
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
      {['owner_confirmed', 'both_live', 'challenged'].includes(claim.state) && (
        <CoPresence
          claim={claim}
          claimToken={stored.claimToken}
          region={region}
          onPass={(r) => {
            setPassed(r);
            onSignedIn(r.sessionToken);
          }}
        />
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
