import { readFile } from 'node:fs/promises';
import { pool } from '../db.js';

const schema = await readFile(new URL('../../sql/schema.sql', import.meta.url), 'utf8');
await pool.query(schema);
console.log('Database schema is up to date.');
await pool.end();
