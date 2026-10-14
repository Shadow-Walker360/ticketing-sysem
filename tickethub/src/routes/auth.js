import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { pool } from '../db.js';
import { HttpError } from '../errors.js';
import { signToken } from '../auth.js';
import { requireObject, requireString } from '../validate.js';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Used so a login for an unknown email takes as long as one for a real email.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

export function authRoutes() {
  const router = Router();

  router.post('/register', async (req, res) => {
    const body = requireObject(req.body);
    const email = requireString(body, 'email', { max: 254 }).toLowerCase();
    const name = requireString(body, 'name', { max: 100 });
    const password = requireString(body, 'password', { min: 8, max: 72 });
    if (!EMAIL_PATTERN.test(email)) {
      throw new HttpError(400, 'INVALID_INPUT', 'email is not a valid address');
    }

    const passwordHash = await bcrypt.hash(password, 10);
    try {
      const { rows } = await pool.query(
        'INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3) RETURNING id',
        [email, passwordHash, name],
      );
      const user = { id: rows[0].id, email, name };
      res.status(201).json({ user, token: signToken(user.id) });
    } catch (error) {
      if (error.code === '23505') {
        throw new HttpError(409, 'EMAIL_TAKEN', 'An account with this email already exists');
      }
      throw error;
    }
  });

  router.post('/login', async (req, res) => {
    const body = requireObject(req.body);
    const email = requireString(body, 'email', { max: 254 }).toLowerCase();
    const password = requireString(body, 'password', { max: 72 });

    const { rows } = await pool.query(
      'SELECT id, name, password_hash FROM users WHERE email = $1',
      [email],
    );
    const user = rows[0];
    const matches = await bcrypt.compare(password, user?.password_hash ?? DUMMY_HASH);
    if (!user || !matches) {
      throw new HttpError(401, 'INVALID_CREDENTIALS', 'Incorrect email or password');
    }
    res.json({ user: { id: user.id, email, name: user.name }, token: signToken(user.id) });
  });

  return router;
}
