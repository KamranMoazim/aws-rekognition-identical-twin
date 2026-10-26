import { FaceLivenessDetector } from '@aws-amplify/ui-react-liveness';
import { useEffect, useRef, useState } from 'react';

type Props = {
  /** Asks the backend for a liveness session id (register, login or a claim role). */
  start: () => Promise<string>;
  region: string;
  /** Called with the spent session id once AWS finishes its analysis. */
  onComplete: (sessionId: string) => void;
  onCancel: () => void;
};

/**
 * Asks the backend for a liveness session, then lets Amplify's detector
 * stream the camera into it. The browser never sees the verdict: the
 * backend reads results itself when we hand it the session id.
 */
export function Liveness({ start, region, onComplete, onCancel }: Props) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false); // StrictMode runs effects twice in dev

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    start()
      .then(setSessionId)
      .catch((e: Error) => setError(e.message));
  }, [start]);

  if (error) {
    return (
      <div className="card error">
        <p>Liveness error: {error}</p>
        <button onClick={onCancel}>Back</button>
      </div>
    );
  }
  if (!sessionId) return <p className="muted">Starting liveness session...</p>;

  return (
    <div className="liveness">
      <FaceLivenessDetector
        sessionId={sessionId}
        region={region}
        onAnalysisComplete={async () => onComplete(sessionId)}
        onUserCancel={onCancel}
        onError={(e) => setError(`${e.state}: ${e.error?.message ?? 'unknown error'}`)}
      />
    </div>
  );
}
