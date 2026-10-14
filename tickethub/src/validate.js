import { HttpError } from './errors.js';

export function parseId(value, name = 'id') {
  const text = String(value);
  if (!/^[1-9]\d{0,9}$/.test(text) || Number(text) > 2_147_483_647) {
    throw new HttpError(400, 'INVALID_INPUT', `${name} must be a positive integer`);
  }
  return Number(text);
}

export function requireObject(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'INVALID_INPUT', 'Request body must be a JSON object');
  }
  return body;
}

export function requireString(body, key, { min = 1, max = 200 } = {}) {
  const value = body[key];
  if (typeof value !== 'string') {
    throw new HttpError(400, 'INVALID_INPUT', `${key} must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) {
    throw new HttpError(400, 'INVALID_INPUT', `${key} must be between ${min} and ${max} characters`);
  }
  return trimmed;
}

export function requireIdempotencyKey(body) {
  return requireString(body, 'idempotencyKey', { min: 8, max: 100 });
}

export function parsePositiveInt(value, fallback, { max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined) return fallback;
  if (!/^\d{1,9}$/.test(String(value)) || Number(value) < 1) {
    throw new HttpError(400, 'INVALID_INPUT', 'Pagination values must be positive integers');
  }
  return Math.min(Number(value), max);
}

export function escapeLike(text) {
  return text.replace(/[\\%_]/g, (char) => `\\${char}`);
}
