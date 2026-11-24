import './env.js';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import { db } from './db.js';

const email = process.env.OWNER_EMAIL?.trim().toLowerCase();
const password = process.env.OWNER_PASSWORD;
if (!email || !password || password.length < 12 || password.startsWith('replace-with-')) {
  throw new Error('Set OWNER_EMAIL and a unique OWNER_PASSWORD of at least 12 characters in the project root .env before setup.');
}
const schema = await readFile(fileURLToPath(new URL('../schema.sql', import.meta.url)), 'utf8');
await db.query(schema);
const hash = await bcrypt.hash(password, 12);
await db.query('INSERT INTO users (name,email,password_hash,role) VALUES ($1,$2,$3,$4) ON CONFLICT (email) DO NOTHING', ['Owner', email, hash, 'owner']);
console.log('Schema and first owner are ready.');
await db.end();
