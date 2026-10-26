import { timingSafeEqual } from 'node:crypto';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { config } from '../config.js';
import { HttpError, requireString } from '../lib/http.js';
import { decide, reviewQueue } from '../services/review.js';

export const adminRouter = Router();

/** Shared-secret admin auth (learning build). Disabled when ADMIN_TOKEN is unset. */
function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  if (!config.adminToken) throw new HttpError(503, 'admin_disabled', 'Set ADMIN_TOKEN in server/.env to use the review queue.');
  const given = Buffer.from(req.get('x-admin-token') ?? '');
  const expected = Buffer.from(config.adminToken);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new HttpError(401, 'bad_admin_token', 'Wrong admin token');
  }
  next();
}

adminRouter.use('/admin', requireAdmin);

adminRouter.get('/admin/review-queue', async (_req, res) => {
  res.json({ items: await reviewQueue() });
});

/** Body: { decision: "reject" | "reopen" } */
adminRouter.post('/admin/claims/:id/decision', async (req, res) => {
  const decision = requireString(req.body, 'decision');
  if (decision !== 'reject' && decision !== 'reopen') throw new HttpError(400, 'bad_request', 'decision must be reject or reopen');
  const claim = await decide(String(req.params.id), decision);
  res.json({ claim: { id: claim.id, state: claim.state, reviewDecision: claim.reviewDecision } });
});
