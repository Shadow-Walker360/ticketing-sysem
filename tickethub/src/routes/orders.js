import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { config } from '../config.js';
import { HttpError } from '../errors.js';
import { cancelOrder, createOrder, getOrderForUser, payOrder } from '../orders.js';
import { parseId, requireIdempotencyKey, requireObject, requireString } from '../validate.js';

function parseSeatIds(body) {
  const { seatIds } = body;
  if (!Array.isArray(seatIds) || seatIds.length === 0) {
    throw new HttpError(400, 'INVALID_INPUT', 'seatIds must be a non-empty array');
  }
  if (seatIds.length > config.maxSeatsPerOrder) {
    throw new HttpError(422, 'TOO_MANY_SEATS', `At most ${config.maxSeatsPerOrder} seats per order`);
  }
  const ids = seatIds.map((id) => parseId(id, 'seatIds[]'));
  if (new Set(ids).size !== ids.length) {
    throw new HttpError(422, 'INVALID_SEATS', 'seatIds must not contain duplicates');
  }
  return ids;
}

export function orderRoutes({ paymentProvider }) {
  const router = Router();
  router.use(requireAuth);

  router.post('/', async (req, res) => {
    const body = requireObject(req.body);
    const eventId = parseId(body.eventId, 'eventId');
    const seatIds = parseSeatIds(body);
    const idempotencyKey = requireIdempotencyKey(body);

    const { order, created } = await createOrder({
      userId: req.user.id,
      eventId,
      seatIds,
      idempotencyKey,
    });
    res.status(created ? 201 : 200).json(order);
  });

  router.get('/:orderId', async (req, res) => {
    const orderId = parseId(req.params.orderId, 'orderId');
    res.json(await getOrderForUser(orderId, req.user.id));
  });

  router.delete('/:orderId', async (req, res) => {
    const orderId = parseId(req.params.orderId, 'orderId');
    await cancelOrder(orderId, req.user.id);
    res.status(204).end();
  });

  router.post('/:orderId/payments', async (req, res) => {
    const orderId = parseId(req.params.orderId, 'orderId');
    const body = requireObject(req.body);
    const paymentToken = requireString(body, 'paymentToken', { max: 200 });
    const idempotencyKey = requireIdempotencyKey(body);

    const { order, replay } = await payOrder({
      orderId,
      userId: req.user.id,
      paymentToken,
      idempotencyKey,
      paymentProvider,
    });
    res.status(replay ? 200 : 201).json({
      orderId: order.orderId,
      status: order.status,
      tickets: order.seatIds.map((seatId) => ({ seatId })),
    });
  });

  return router;
}
