import { useCallback, useEffect, useState } from 'react';
import { api, errorBody, type ClaimView } from './api';

/**
 * Shown to whoever is logged in to an identity that has claims against it.
 * Confirming needs the recovery code: a lookalike can log in here by face,
 * but only the real owner holds the code.
 */
export function OwnerClaims({ token }: { token: string }) {
  const [claims, setClaims] = useState<ClaimView[]>([]);
  const [codes, setCodes] = useState<Record<string, string>>({});
  const [messages, setMessages] = useState<Record<string, string>>({});

  const load = useCallback(() => {
    api
      .myClaims(token)
      .then((r) => setClaims(r.claims))
      .catch(() => setClaims([]));
  }, [token]);

  useEffect(() => {
    load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, [load]);

  async function act(id: string, action: 'confirm' | 'decline' | 'cancel') {
    const done = { confirm: 'Confirmed.', decline: 'Declined: sent to manual review.', cancel: 'Claim cancelled.' };
    try {
      if (action === 'confirm') await api.ownerConfirm(id, codes[id] ?? '', token);
      else if (action === 'decline') await api.ownerDecline(id, token);
      else await api.ownerCancel(id, token);
      setMessages((m) => ({ ...m, [id]: done[action] }));
      load();
    } catch (e) {
      const body = errorBody(e);
      const left = typeof body.attemptsLeft === 'number' ? ` (${body.attemptsLeft} tries left)` : '';
      setMessages((m) => ({ ...m, [id]: body.message + left }));
    }
  }

  if (!claims.length) return null;
  return (
    <section className="card warn">
      <h2>Someone says they are not you</h2>
      <p className="muted">
        A person whose face matches yours started a claim to get their own identity. If you know them (a twin, a
        lookalike relative), confirm with your recovery code and you will both do a joint camera check. Your account
        is not changed by this.
      </p>
      {claims.map((c) => (
        <div key={c.id} className="claim">
          <p>
            <strong>{c.claimantName}</strong> <span className="badge">{c.state}</span>
            {c.owners.required > 1 && (
              <span className="badge">
                {c.owners.confirmed} of {c.owners.required} owners confirmed
              </span>
            )}
            <br />
            <span className="muted">{c.nextStep}</span>
          </p>
          {c.state === 'open' && c.owners.youConfirmed && (
            <p className="muted">You confirmed. Waiting for the other owner(s) of your group.</p>
          )}
          {c.state === 'open' && !c.owners.youConfirmed && (
            <div className="row">
              <input
                placeholder="Recovery code, e.g. K7QD-9MXA-T3PW"
                value={codes[c.id] ?? ''}
                onChange={(e) => setCodes((x) => ({ ...x, [c.id]: e.target.value }))}
              />
              <button disabled={!codes[c.id]?.trim()} onClick={() => act(c.id, 'confirm')}>Confirm</button>
              <button className="secondary" onClick={() => act(c.id, 'decline')}>I do not know them</button>
            </div>
          )}
          {c.state !== 'open' && (
            <div className="row">
              <button className="secondary" onClick={() => act(c.id, 'cancel')}>Cancel this claim</button>
            </div>
          )}
          {messages[c.id] && <p className="muted">{messages[c.id]}</p>}
        </div>
      ))}
    </section>
  );
}
