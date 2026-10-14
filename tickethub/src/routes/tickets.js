import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { listTickets } from '../orders.js';

export function userRoutes() {
  const router = Router();
  router.use(requireAuth);

  router.get('/me/tickets', async (req, res) => {
    res.json({ tickets: await listTickets(req.user.id) });
  });

  return router;
}
