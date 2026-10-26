import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorBody, type ChallengeView, type ClaimView, type JointResult, type Role } from './api';
import { Liveness } from './Liveness';

type Props = {
  claim: ClaimView;
  claimToken: string;
  region: string;
  onPass: (r: Extract<JointResult, { result: 'pass' }>) => void;
};

const ROLE_LABEL: Record<Role, string> = { owner: 'Account owner', claimant: 'You (claimant)' };

/**
 * Both people, on this one device:
 *   1. each passes Face Liveness (one face per session, as AWS requires)
 *   2. both stand together and follow a random instruction each; one photo is taken
 */
export function CoPresence({ claim, claimToken, region, onPass }: Props) {
  const [liveness, setLiveness] = useState<Record<Role, boolean>>({ owner: false, claimant: false });
  const [running, setRunning] = useState<Role | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api
      .claimLiveness(claim.id, claimToken)
      .then((r) => setLiveness(r.liveness))
      .catch(() => undefined);
  }, [claim.id, claimToken]);

  useEffect(refresh, [refresh, claim.state]);

  async function finish(role: Role, sessionId: string) {
    setRunning(null);
    setMessage('Checking...');
    try {
      const r = await api.claimLivenessDone(claim.id, role, sessionId, claimToken);
      setLiveness(r.liveness);
      setMessage(`${ROLE_LABEL[role]}: passed.`);
    } catch (e) {
      setMessage(`${ROLE_LABEL[role]}: ${errorBody(e).message}`);
    }
  }

  if (running) {
    return (
      <div>
        <p>
          <strong>{ROLE_LABEL[running]}</strong>: only you in front of the camera for this check.
        </p>
        <Liveness
          start={() => api.claimLivenessSession(claim.id, running, claimToken).then((r) => r.sessionId)}
          region={region}
          onComplete={(id) => finish(running, id)}
          onCancel={() => setRunning(null)}
        />
      </div>
    );
  }

  const bothLive = claim.state === 'both_live' || claim.state === 'challenged';
  return (
    <div className="copresence">
      <h3>1. Liveness, one person at a time</h3>
      {(['owner', 'claimant'] as Role[]).map((role) => (
        <div key={role} className="row step">
          <span className={liveness[role] ? 'done' : ''}>
            {liveness[role] ? 'Passed: ' : ''}
            {ROLE_LABEL[role]}
          </span>
          {!liveness[role] && (
            <button className="secondary" onClick={() => setRunning(role)}>
              Start check
            </button>
          )}
        </div>
      ))}
      {message && <p className="muted">{message}</p>}

      <h3>2. Joint check, both together</h3>
      {bothLive ? (
        <JointCheck claim={claim} claimToken={claimToken} onPass={onPass} />
      ) : (
        <p className="muted">Unlocks when both liveness checks pass (they stay valid for 10 minutes).</p>
      )}
    </div>
  );
}

const COUNTDOWN = 8;

function JointCheck({ claim, claimToken, onPass }: Omit<Props, 'region'>) {
  const video = useRef<HTMLVideoElement>(null);
  const [camError, setCamError] = useState<string | null>(null);
  const [challenge, setChallenge] = useState<ChallengeView | null>(null);
  const [count, setCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Extract<JointResult, { result: 'fail' }> | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Camera preview. NOT mirrored, so "left of the screen" is "left in the photo".
  useEffect(() => {
    let stream: MediaStream | null = null;
    navigator.mediaDevices
      .getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false })
      .then((s) => {
        stream = s;
        if (video.current) video.current.srcObject = s;
      })
      .catch((e: Error) => setCamError(e.message));
    return () => stream?.getTracks().forEach((t) => t.stop());
  }, []);

  async function start() {
    setError(null);
    setResult(null);
    try {
      const ch = await api.challenge(claim.id, claimToken);
      setChallenge(ch);
      setCount(COUNTDOWN);
    } catch (e) {
      setError(errorBody(e).message);
    }
  }

  // Countdown, then take exactly one photo.
  useEffect(() => {
    if (!challenge || count <= 0) return;
    const t = setTimeout(() => setCount((c) => c - 1), 1000);
    if (count === 1) setTimeout(capture, 1000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [count, challenge]);

  async function capture() {
    const v = video.current;
    if (!v || !v.videoWidth) return setError('Camera not ready');
    const canvas = document.createElement('canvas');
    canvas.width = v.videoWidth;
    canvas.height = v.videoHeight;
    canvas.getContext('2d')!.drawImage(v, 0, 0);
    const image = canvas.toDataURL('image/jpeg', 0.9);
    setBusy(true);
    try {
      const r = await api.jointCapture(claim.id, image, claimToken);
      if (r.result === 'pass') onPass(r);
      else setResult(r);
    } catch (e) {
      setError(errorBody(e).message);
    } finally {
      setBusy(false);
      setChallenge(null);
    }
  }

  const sideOf = (role: 'owner' | 'claimant') =>
    !challenge ? '' : (challenge.claimantSide === 'left') === (role === 'claimant') ? 'LEFT' : 'RIGHT';

  return (
    <div>
      {camError && <p className="error-text">Camera: {camError}</p>}
      <div className="stage">
        <video ref={video} autoPlay playsInline muted />
        {challenge && (
          <div className="overlay">
            <div className="half">
              <strong>LEFT person</strong>
              <span>{challenge.instructions.left}</span>
            </div>
            <div className="count">{count > 0 ? count : '...'}</div>
            <div className="half">
              <strong>RIGHT person</strong>
              <span>{challenge.instructions.right}</span>
            </div>
          </div>
        )}
      </div>
      {challenge ? (
        <p>
          <strong>Owner on the {sideOf('owner')}, you on the {sideOf('claimant')}</strong> (as seen on screen). Hold
          your pose when the count reaches 1.
        </p>
      ) : (
        <>
          <p className="muted">
            Both stand side by side, faces about the same size on screen. You will get a random side and a different
            head movement each, then {COUNTDOWN} seconds.
          </p>
          <button onClick={start} disabled={busy || !!camError}>
            {busy ? 'Checking...' : result ? 'Try again' : 'Start joint check'}
          </button>
        </>
      )}
      {error && <p className="error-text">{error}</p>}
      {result && (
        <div className="result">
          <p>
            <strong>Not passed.</strong> {result.attemptsLeft} attempt(s) left
            {result.attemptsLeft === 0 ? ': the claim was sent to manual review.' : '.'}
          </p>
          <ul>
            {result.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
          {result.faces.length > 0 && <FaceTable faces={result.faces} />}
        </div>
      )}
    </div>
  );
}

/** What Rekognition measured, for learning and threshold tuning. */
export function FaceTable({ faces }: { faces: JointResult['faces'] }) {
  return (
    <table>
      <thead>
        <tr>
          <th>Side</th>
          <th>Role</th>
          <th>Asked</th>
          <th>Yaw / Roll / Pitch</th>
          <th>Pose</th>
          <th>Similarity</th>
          <th>Identity</th>
        </tr>
      </thead>
      <tbody>
        {faces.map((f) => (
          <tr key={f.side}>
            <td>{f.side}</td>
            <td>{f.role}</td>
            <td>{f.expectedPose}</td>
            <td>
              {f.pose.yaw} / {f.pose.roll} / {f.pose.pitch}
            </td>
            <td>{f.poseOk ? 'ok' : 'no'}</td>
            <td>{f.similarity ?? '-'}</td>
            <td>{f.identityOk ? 'ok' : 'no'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
