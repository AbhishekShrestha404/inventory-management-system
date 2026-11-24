import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import { db } from './db.js';

const schema = await readFile(fileURLToPath(new URL('../schema.sql', import.meta.url)), 'utf8');
await db.query(schema);
const email = process.env.OWNER_EMAIL?.trim().toLowerCase();
const password = process.env.OWNER_PASSWORD;
if (!email || !password || password.length < 12) {
  console.error('Schema is ready. Set OWNER_EMAIL and OWNER_PASSWORD (12+ characters) to create the first owner.');
} else {
  const hash = await bcrypt.hash(password, 12);
  await db.query('INSERT INTO users (name,email,password_hash,role) VALUES ($1,$2,$3,$4) ON CONFLICT (email) DO NOTHING', ['Owner', email, hash, 'owner']);
  console.log('Schema and first owner are ready.');
}
await db.end();
