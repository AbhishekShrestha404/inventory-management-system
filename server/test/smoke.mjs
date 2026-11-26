import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';
import '../dist/env.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const baseUrl = process.env.DATABASE_URL;
if (!baseUrl || !process.env.OWNER_EMAIL || !process.env.OWNER_PASSWORD || !process.env.JWT_SECRET) {
  throw new Error('Set DATABASE_URL, OWNER_EMAIL, OWNER_PASSWORD, and JWT_SECRET in the root .env');
}
const dbName = `mavya_smoke_${process.pid}_${Date.now()}`;
const adminUrl = new URL(baseUrl);
adminUrl.pathname = '/postgres';
const testUrl = new URL(baseUrl);
testUrl.pathname = `/${dbName}`;
const admin = new pg.Pool({ connectionString: adminUrl.toString(), connectionTimeoutMillis: 5000 });
const port = 41000 + Math.floor(Math.random() * 20000);
const origin = `http://127.0.0.1:${port}`;
let server;
let created = false;
let serverError = '';

async function call(endpoint, method = 'GET', body, cookie) {
  const response = await fetch(`${origin}/api${endpoint}`, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(8000),
  });
  const data = await response.json();
  return { status: response.status, data, cookie: response.headers.get('set-cookie')?.split(';')[0] };
}

async function bootServer() {
  server = spawn(process.execPath, ['server/dist/index.js'], {
    cwd: root,
    env: { ...process.env, DATABASE_URL: testUrl.toString(), PORT: String(port) },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  server.stderr.on('data', chunk => { serverError += chunk.toString(); });
  for (let attempt = 0; attempt < 50; attempt++) {
    if (server.exitCode !== null) throw new Error(`API exited during startup: ${serverError}`);
    try { await call('/auth/me'); return; } catch { await delay(100); }
  }
  throw new Error(`API did not start: ${serverError}`);
}

try {
  await admin.query(`CREATE DATABASE "${dbName}"`);
  created = true;
  const setup = spawn(process.execPath, ['server/dist/setup.js'], {
    cwd: root,
    env: { ...process.env, DATABASE_URL: testUrl.toString() },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let setupError = '';
  setup.stderr.on('data', chunk => { setupError += chunk.toString(); });
  const [setupCode] = await once(setup, 'exit');
  if (setupCode !== 0) throw new Error(`Database setup failed: ${setupError}`);

  await bootServer();
  const health = await call('/health');
  assert.equal(health.status, 200, 'health check confirms database connectivity');
  assert.equal(health.data.status, 'ok');
  const login = await call('/auth/login', 'POST', { email: process.env.OWNER_EMAIL, password: process.env.OWNER_PASSWORD });
  assert.equal(login.status, 200, 'owner can sign in');
  assert.ok(login.cookie, 'login sets a session cookie');
  const cookie = login.cookie;
  const day = (await call('/dashboard', 'GET', undefined, cookie)).data.today;
  const expiry = new Date(`${day}T00:00:00Z`);
  expiry.setUTCDate(expiry.getUTCDate() + 7);

  const draft = await call('/products', 'POST', { sweet_name: 'Smoke test sweet', variant: 'One packet', sku: 'SMOKE-1', price: 100, daily_target: 6, low_stock: 1, shelf_life_days: 7, active: false, recipe: [] }, cookie);
  assert.equal(draft.status, 201, JSON.stringify(draft.data));
  assert.equal((await call('/products', 'GET', undefined, cookie)).data.some(p => Number(p.id) === Number(draft.data.id)), true, 'draft packet appears in catalog');
  assert.equal((await call('/orders', 'POST', { customer_name: 'Too early', phone: '9800000000', due_date: day, fulfillment: 'pickup', items: [{ product_id: draft.data.id, quantity: 1 }] }, cookie)).status, 400, 'inactive packet cannot be ordered');
  assert.equal((await call(`/products/${draft.data.id}`, 'PUT', { sweet_name: 'Smoke test sweet', variant: 'One packet', sku: 'SMOKE-1', price: 100, daily_target: 6, low_stock: 1, shelf_life_days: 7, active: true, recipe: [] }, cookie)).status, 400, 'packet needs a recipe before activation');

  const ingredient = await call('/ingredients', 'POST', { name: 'Smoke test khoa', unit: 'kg', low_stock: 1 }, cookie);
  assert.equal(ingredient.status, 201, JSON.stringify(ingredient.data));
  const receipt = await call('/receipts', 'POST', { ingredient_id: ingredient.data.id, supplier: 'Smoke test supplier', quantity: 5, unit_cost: 100, expires_at: expiry.toISOString().slice(0, 10) }, cookie);
  assert.equal(receipt.status, 201, JSON.stringify(receipt.data));
  const product = await call(`/products/${draft.data.id}`, 'PUT', { sweet_name: 'Smoke test sweet', variant: 'One packet', sku: 'SMOKE-1', price: 100, daily_target: 6, low_stock: 1, shelf_life_days: 7, active: true, recipe: [{ ingredient_id: ingredient.data.id, qty_per_packet: 0.5 }] }, cookie);
  assert.equal(product.status, 200, JSON.stringify(product.data));
  const batch = await call('/batches', 'POST', { product_id: product.data.id, produced_qty: 6, produced_at: day }, cookie);
  assert.equal(batch.status, 201, JSON.stringify(batch.data));
  const order = await call('/orders', 'POST', { customer_name: 'Smoke test customer', phone: '9800000000', due_date: day, fulfillment: 'pickup', items: [{ product_id: product.data.id, quantity: 4 }] }, cookie);
  assert.equal(order.status, 201, JSON.stringify(order.data));
  assert.equal(Number(order.data.total), 400);
  const edited = await call(`/orders/${order.data.id}`, 'PUT', { customer_name: 'Edited customer', phone: '9800000000', due_date: day, fulfillment: 'pickup', notes: 'Updated quantity', items: [{ product_id: product.data.id, quantity: 5 }] }, cookie);
  assert.equal(edited.status, 200, JSON.stringify(edited.data));
  assert.equal(Number(edited.data.total), 500, 'editing quantity updates the total');
  assert.equal((await call(`/orders/${order.data.id}/fulfill`, 'POST', undefined, cookie)).status, 200);
  assert.equal((await call(`/orders/${order.data.id}/fulfill`, 'POST', undefined, cookie)).status, 409, 'fulfillment is idempotently rejected');
  assert.equal((await call(`/orders/${order.data.id}`, 'PUT', { customer_name: 'Too late', phone: '9800000000', due_date: day, fulfillment: 'pickup', items: [{ product_id: product.data.id, quantity: 1 }] }, cookie)).status, 409, 'fulfilled orders cannot be edited');

  const shortage = await call('/orders', 'POST', { customer_name: 'Shortage customer', phone: '9800000001', due_date: day, fulfillment: 'pickup', items: [{ product_id: product.data.id, quantity: 2 }] }, cookie);
  assert.equal(shortage.status, 201);
  assert.equal((await call(`/orders/${shortage.data.id}/fulfill`, 'POST', undefined, cookie)).status, 409, 'shortage is rejected');
  assert.equal((await call(`/orders/${shortage.data.id}/cancel`, 'POST', undefined, cookie)).status, 200, 'confirmed order can be cancelled');
  assert.equal((await call(`/orders/${shortage.data.id}/fulfill`, 'POST', undefined, cookie)).status, 409, 'cancelled order cannot be fulfilled');
  const products = await call('/products', 'GET', undefined, cookie);
  assert.equal(Number(products.data.find(p => Number(p.id) === Number(product.data.id)).stock), 1, 'failed fulfillment leaves stock unchanged');
  const changedIngredient = await call(`/ingredients/${ingredient.data.id}`, 'PATCH', { name: 'Renamed smoke test khoa', low_stock: 0, active: false }, cookie);
  assert.equal(changedIngredient.status, 200, JSON.stringify(changedIngredient.data));
  const ingredients = await call('/ingredients', 'GET', undefined, cookie);
  assert.equal(Number(ingredients.data.find(i => Number(i.id) === Number(ingredient.data.id)).stock), 2, 'batch consumed the recipe quantity');
  assert.equal(ingredients.data.find(i => Number(i.id) === Number(ingredient.data.id)).active, false, 'deactivated ingredient remains readable');
  const movements = await call('/movements', 'GET', undefined, cookie);
  assert.equal(movements.data.length, 4, 'receipt, ingredient use, output, and fulfillment are audited');
  const staff = await call('/users', 'POST', { name: 'Smoke staff', email: 'smoke-staff@example.com', password: 'smoke-test-pass-123', role: 'staff' }, cookie);
  assert.equal(staff.status, 201, JSON.stringify(staff.data));
  const staffLogin = await call('/auth/login', 'POST', { email: 'smoke-staff@example.com', password: 'smoke-test-pass-123' });
  assert.equal(staffLogin.status, 200);
  assert.equal((await call('/ingredients', 'POST', { name: 'Forbidden', unit: 'kg', low_stock: 0 }, staffLogin.cookie)).status, 403, 'staff cannot manage catalog');
  assert.equal((await call(`/users/${staff.data.id}`, 'PATCH', { name: 'Former staff', email: 'smoke-staff@example.com', role: 'staff', active: false }, cookie)).status, 200);
  assert.equal((await call('/auth/me', 'GET', undefined, staffLogin.cookie)).status, 401, 'deactivation revokes existing session');
  assert.equal((await call(`/users/${login.data.id}`, 'PATCH', { name: 'Owner', email: process.env.OWNER_EMAIL, role: 'owner', active: false }, cookie)).status, 400, 'owner cannot deactivate own account');
  console.log('Smoke test passed: inventory and order CRUD, stock history, and staff access revocation.');
} finally {
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await Promise.race([once(server, 'exit'), delay(2000)]);
  }
  if (created) await admin.query(`DROP DATABASE "${dbName}" WITH (FORCE)`);
  await admin.end();
}
