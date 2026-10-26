import { useState } from 'react';
import { api, errorBody, type LoggedIn } from './api';

const pinOk = (p: string) => /^\d{6}$/.test(p);

function PinInput({ label, value, onChange, autoFocus }: { label: string; value: string; onChange: (v: string) => void; autoFocus?: boolean }) {
  return (
    <label>
      {label}
      <input
        className="pin"
        type="password"
        inputMode="numeric"
        autoComplete="off"
        maxLength={6}
        value={value}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, ''))}
      />
    </label>
  );
}

function explain(err: unknown): string {
  const b = errorBody(err);
  return typeof b.attemptsLeft === 'number' ? `${b.message} ${b.attemptsLeft} attempt(s) left.` : b.message;
}

/**
 * After face login found a collision group: the PIN picks the person.
 * No PIN yet (new group) or forgot it: recovery code + new PIN.
 */
export function PinLogin({
  pinToken,
  onLoggedIn,
  onCancel,
}: {
  pinToken: string;
  onLoggedIn: (r: LoggedIn, newRecoveryCode?: string) => void;
  onCancel: () => void;
}) {
  const [mode, setMode] = useState<'pin' | 'recovery'>('pin');
  const [pin, setPin] = useState('');
  const [code, setCode] = useState('');
  const [newPin, setNewPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === 'pin') onLoggedIn(await api.loginPin(pinToken, pin));
      else {
        const r = await api.loginRecovery(pinToken, code, newPin);
        onLoggedIn(r, r.recoveryCode);
      }
    } catch (err) {
      setError(explain(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card warn" onSubmit={submit}>
      <h2>This face belongs to more than one person</h2>
      {mode === 'pin' ? (
        <>
          <p className="muted">Your face found your collision group. Your PIN tells us which of you it is.</p>
          <PinInput label="Your 6-digit PIN" value={pin} onChange={setPin} autoFocus />
          <div className="row">
            <button type="submit" disabled={busy || !pinOk(pin)}>Log in</button>
            <button type="button" className="secondary" onClick={() => setMode('recovery')}>
              No PIN yet / forgot it
            </button>
            <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
          </div>
        </>
      ) : (
        <>
          <p className="muted">
            Use your recovery code to set a new PIN. A face alone can never reset a PIN, because it cannot tell you
            apart. You will get a new recovery code; the old one stops working.
          </p>
          <label>
            Recovery code
            <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="K7QD-9MXA-T3PW" autoFocus />
          </label>
          <PinInput label="New 6-digit PIN" value={newPin} onChange={setNewPin} />
          <PinInput label="Repeat new PIN" value={confirm} onChange={setConfirm} />
          {confirm && newPin !== confirm && <p className="error-text">PINs do not match.</p>}
          <div className="row">
            <button type="submit" disabled={busy || !code.trim() || !pinOk(newPin) || newPin !== confirm}>
              Set PIN and log in
            </button>
            <button type="button" className="secondary" onClick={() => setMode('pin')}>Back to PIN</button>
          </div>
        </>
      )}
      {error && <p className="error-text">{error}</p>}
    </form>
  );
}

/** Set a first PIN (needsPin) or change it (needs the current PIN). */
export function PinSetup({ token, hasPin, onDone }: { token: string; hasPin: boolean; onDone: () => void }) {
  const [current, setCurrent] = useState('');
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    try {
      await api.setPin(token, pin, hasPin ? current : undefined);
      setMsg({ ok: true, text: hasPin ? 'PIN changed.' : 'PIN set.' });
      setCurrent('');
      setPin('');
      setConfirm('');
      onDone();
    } catch (err) {
      setMsg({ ok: false, text: explain(err) });
    }
  }

  return (
    <form onSubmit={submit} className="pin-setup">
      {hasPin && <PinInput label="Current PIN" value={current} onChange={setCurrent} />}
      <PinInput label={hasPin ? 'New PIN' : '6-digit PIN'} value={pin} onChange={setPin} />
      <PinInput label="Repeat PIN" value={confirm} onChange={setConfirm} />
      {confirm && pin !== confirm && <p className="error-text">PINs do not match.</p>}
      <div className="row">
        <button type="submit" disabled={!pinOk(pin) || pin !== confirm || (hasPin && !pinOk(current))}>
          {hasPin ? 'Change PIN' : 'Set PIN'}
        </button>
      </div>
      {msg && <p className={msg.ok ? 'ok-text' : 'error-text'}>{msg.text}</p>}
      <p className="muted small">No repeated or sequential digits (111111, 123456). Members of one group cannot share a PIN.</p>
    </form>
  );
}
