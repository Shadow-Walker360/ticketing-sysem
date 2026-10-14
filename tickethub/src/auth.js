import jwt from 'jsonwebtoken';
import { config } from './config.js';
import { HttpError } from './errors.js';

export function signToken(userId) {
  return jwt.sign({ sub: String(userId) }, config.jwtSecret, { expiresIn: config.jwtExpiresIn });
}

export function requireAuth(req, _res, next) {
  const header = req.get('authorization') ?? '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    throw new HttpError(401, 'UNAUTHENTICATED', 'Log in and send "Authorization: Bearer <token>"');
  }
  try {
    const payload = jwt.verify(token, config.jwtSecret);
    req.user = { id: Number(payload.sub) };
  } catch {
    throw new HttpError(401, 'UNAUTHENTICATED', 'Invalid or expired token');
  }
  next();
}
