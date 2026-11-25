import './env.js';
import express, { type Request, type Response, type NextFunction } from 'express';
import cookieParser from 'cookie-parser';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z, ZodError } from 'zod';
import { db, transaction, businessDay, addDays, type Client } from './db.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 24) throw new Error('JWT_SECRET must have at least 24 characters');
const secret = process.env.JWT_SECRET;
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());

type User = { id: number; name: string; email: string; role: 'owner' | 'staff' };
type Authed = Request & { user: User };
class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }
const id = z.coerce.number().int().positive();
const quantity = z.coerce.number().positive().max(100000000);
const whole = z.coerce.number().int().nonnegative().max(100000000);
const nonnegative = z.coerce.number().nonnegative().max(100000000);
const text = z.string().trim().min(1).max(160);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), 'Invalid date');
const route = (fn: (req: Authed, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => Promise.resolve(fn(req as Authed, res)).catch(next);

const requireUser = (req: Request, _res: Response, next: NextFunction) => {
  void (async () => {
    const token = req.cookies.session;
    if (!token) throw new HttpError(401, 'Sign in to continue');
    let payload: { id: number };
    try {
      payload = jwt.verify(token, secret) as { id: number };
    } catch { throw new HttpError(401, 'Session expired. Sign in again'); }
    const result = await db.query<User>('SELECT id,name,email,role FROM users WHERE id=$1', [payload.id]);
    if (!result.rows[0]) throw new HttpError(401, 'Session expired. Sign in again');
    (req as Authed).user = result.rows[0];
    next();
  })().catch(next);
};
const owner = (req: Request, _res: Response, next: NextFunction) => (req as Authed).user.role === 'owner' ? next() : next(new HttpError(403, 'Owner access required'));

app.post('/api/auth/login', route(async (req, res) => {
  const data = z.object({ email: z.string().email(), password: z.string().min(1) }).parse(req.body);
  const result = await db.query<User & { password_hash: string }>('SELECT id,name,email,role,password_hash FROM users WHERE email=$1', [data.email.trim().toLowerCase()]);
  const user = result.rows[0];
  if (!user || !(await bcrypt.compare(data.password, user.password_hash))) throw new HttpError(401, 'Incorrect email or password');
  const token = jwt.sign({ id: user.id }, secret, { expiresIn: '7d' });
  res.cookie('session', token, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 7 * 86400000, path: '/' });
  res.json({ id: user.id, name: user.name, email: user.email, role: user.role });
}));
app.post('/api/auth/logout', (_req, res) => { res.clearCookie('session', { path: '/' }); res.json({ ok: true }); });
app.get('/api/auth/me', requireUser, (req, res) => res.json((req as Authed).user));
app.use('/api', requireUser);

app.get('/api/ingredients', route(async (_req, res) => {
  const result = await db.query(`SELECT i.*, COALESCE((SELECT SUM(remaining_qty) FROM ingredient_lots l WHERE l.ingredient_id=i.id AND l.expires_at >= $1),0) AS stock FROM ingredients i ORDER BY i.name`, [businessDay()]);
  res.json(result.rows);
}));
app.post('/api/ingredients', owner, route(async (req, res) => {
  const data = z.object({ name: text, unit: z.enum(['kg','g','l','ml','piece']), low_stock: nonnegative }).parse(req.body);
  const result = await db.query('INSERT INTO ingredients(name,unit,low_stock) VALUES($1,$2,$3) RETURNING *', [data.name, data.unit, data.low_stock]);
  res.status(201).json(result.rows[0]);
}));
app.patch('/api/ingredients/:id', owner, route(async (req, res) => {
  const data = z.object({ name: text, low_stock: nonnegative, active: z.boolean() }).parse(req.body);
  const result = await db.query('UPDATE ingredients SET name=$1,low_stock=$2,active=$3 WHERE id=$4 RETURNING *', [data.name,data.low_stock,data.active,id.parse(req.params.id)]);
  if (!result.rows[0]) throw new HttpError(404,'Ingredient not found');
  res.json(result.rows[0]);
}));
app.get('/api/receipts', route(async (_req, res) => {
  const result = await db.query('SELECT l.*,i.name AS ingredient_name,i.unit FROM ingredient_lots l JOIN ingredients i ON i.id=l.ingredient_id ORDER BY l.id DESC LIMIT 100');
  res.json(result.rows);
}));
app.post('/api/receipts', route(async (req, res) => {
  const data = z.object({ ingredient_id:id, supplier:text, quantity, unit_cost:z.coerce.number().nonnegative(), expires_at:day }).parse(req.body);
  if (data.expires_at < businessDay()) throw new HttpError(400,'Expiry must be today or later');
  const result = await transaction(async c => {
    const ingredient = await c.query('SELECT id FROM ingredients WHERE id=$1 AND active=true', [data.ingredient_id]);
    if (!ingredient.rows[0]) throw new HttpError(400,'Select an active ingredient');
    const lot = await c.query('INSERT INTO ingredient_lots(ingredient_id,supplier,received_at,expires_at,received_qty,remaining_qty,unit_cost) VALUES($1,$2,$3,$4,$5,$5,$6) RETURNING *', [data.ingredient_id,data.supplier,businessDay(),data.expires_at,data.quantity,data.unit_cost]);
    await movement(c,'ingredient',data.ingredient_id,lot.rows[0].id,data.quantity,'receipt',lot.rows[0].id,req.user.id);
    return lot.rows[0];
  });
  res.status(201).json(result);
}));

const recipeSchema = z.array(z.object({ ingredient_id:id, qty_per_packet:quantity })).min(1);
app.get('/api/products', route(async (_req, res) => {
  const result = await db.query(`SELECT p.*, COALESCE((SELECT SUM(remaining_qty) FROM product_lots l WHERE l.product_id=p.id AND l.expires_at >= $1),0) AS stock,
    COALESCE((SELECT json_agg(json_build_object('ingredient_id',r.ingredient_id,'ingredient_name',i.name,'unit',i.unit,'qty_per_packet',r.qty_per_packet) ORDER BY i.name) FROM recipes r JOIN ingredients i ON i.id=r.ingredient_id WHERE r.product_id=p.id),'[]'::json) AS recipe
    FROM products p ORDER BY p.sweet_name,p.variant`, [businessDay()]);
  res.json(result.rows);
}));
app.post('/api/products', owner, route(async (req, res) => {
  const data = z.object({ sweet_name:text, variant:text, sku:text, price:z.coerce.number().nonnegative(), daily_target:whole, low_stock:whole, shelf_life_days:z.coerce.number().int().positive().max(365), active:z.boolean().default(true), recipe:recipeSchema }).parse(req.body);
  if (new Set(data.recipe.map(r => r.ingredient_id)).size !== data.recipe.length) throw new HttpError(400,'Each ingredient can appear once in a recipe');
  const result = await transaction(async c => {
    const p = await c.query('INSERT INTO products(sweet_name,variant,sku,price,daily_target,low_stock,shelf_life_days,active) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *', [data.sweet_name,data.variant,data.sku,data.price,data.daily_target,data.low_stock,data.shelf_life_days,data.active]);
    for (const r of data.recipe) await c.query('INSERT INTO recipes(product_id,ingredient_id,qty_per_packet) VALUES($1,$2,$3)',[p.rows[0].id,r.ingredient_id,r.qty_per_packet]);
    return p.rows[0];
  });
  res.status(201).json(result);
}));
app.put('/api/products/:id', owner, route(async (req, res) => {
  const data = z.object({ sweet_name:text, variant:text, sku:text, price:z.coerce.number().nonnegative(), daily_target:whole, low_stock:whole, shelf_life_days:z.coerce.number().int().positive().max(365), active:z.boolean(), recipe:recipeSchema }).parse(req.body);
  if (new Set(data.recipe.map(r => r.ingredient_id)).size !== data.recipe.length) throw new HttpError(400,'Each ingredient can appear once in a recipe');
  const result = await transaction(async c => {
    const p = await c.query('UPDATE products SET sweet_name=$1,variant=$2,sku=$3,price=$4,daily_target=$5,low_stock=$6,shelf_life_days=$7,active=$8 WHERE id=$9 RETURNING *',[data.sweet_name,data.variant,data.sku,data.price,data.daily_target,data.low_stock,data.shelf_life_days,data.active,id.parse(req.params.id)]);
    if (!p.rows[0]) throw new HttpError(404,'Product not found');
    await c.query('DELETE FROM recipes WHERE product_id=$1',[p.rows[0].id]);
    for (const r of data.recipe) await c.query('INSERT INTO recipes(product_id,ingredient_id,qty_per_packet) VALUES($1,$2,$3)',[p.rows[0].id,r.ingredient_id,r.qty_per_packet]);
    return p.rows[0];
  });
  res.json(result);
}));
app.put('/api/targets/:productId/:date', owner, route(async (req, res) => {
  const productId = id.parse(req.params.productId), date = day.parse(req.params.date), target = whole.parse(req.body.target_qty);
  const result = await db.query('INSERT INTO target_overrides(product_id,production_date,target_qty) VALUES($1,$2,$3) ON CONFLICT(product_id,production_date) DO UPDATE SET target_qty=excluded.target_qty RETURNING *',[productId,date,target]);
  res.json(result.rows[0]);
}));

async function movement(c:Client,type:string,itemId:number,lotId:number,qty:number,reason:string,ref:number,user:number,note='') {
  await c.query('INSERT INTO stock_movements(stock_type,item_id,lot_id,quantity,reason,reference_id,created_by,note) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[type,itemId,lotId,qty,reason,ref,user,note]);
}
async function consume(c:Client, type:'ingredient'|'product', itemId:number, needed:number, reason:string, ref:number, user:number) {
  const table = type === 'ingredient' ? 'ingredient_lots' : 'product_lots';
  const column = type === 'ingredient' ? 'ingredient_id' : 'product_id';
  const lots = await c.query(`SELECT id,remaining_qty FROM ${table} WHERE ${column}=$1 AND expires_at >= $2 AND remaining_qty > 0 ORDER BY expires_at,id FOR UPDATE`,[itemId,businessDay()]);
  let left = needed;
  for (const lot of lots.rows) {
    const take = Math.min(left,Number(lot.remaining_qty));
    if (take <= 0) continue;
    await c.query(`UPDATE ${table} SET remaining_qty=remaining_qty-$1 WHERE id=$2`,[take,lot.id]);
    await movement(c,type,itemId,lot.id,-take,reason,ref,user);
    left = Math.round((left-take)*1000)/1000;
    if (left <= 0) break;
  }
  if (left > 0) throw new HttpError(409,`Insufficient usable ${type} stock for item ${itemId}: need ${needed}, short ${left}`);
}
app.get('/api/batches', route(async (_req, res) => {
  const result = await db.query('SELECT b.*,p.sweet_name,p.variant,p.sku FROM batches b JOIN products p ON p.id=b.product_id ORDER BY b.id DESC LIMIT 100');
  res.json(result.rows);
}));
app.post('/api/batches', route(async (req, res) => {
  const data = z.object({ product_id:id, produced_qty:z.coerce.number().int().positive(), produced_at:day }).parse(req.body);
  if (data.produced_at > businessDay()) throw new HttpError(400,'Production date cannot be in the future');
  const result = await transaction(async c => {
    const p = await c.query('SELECT * FROM products WHERE id=$1 AND active=true FOR UPDATE',[data.product_id]);
    if (!p.rows[0]) throw new HttpError(400,'Select an active packet variant');
    const recipe = await c.query('SELECT ingredient_id,qty_per_packet FROM recipes WHERE product_id=$1 ORDER BY ingredient_id',[data.product_id]);
    if (!recipe.rows.length) throw new HttpError(400,'Add a recipe before producing this packet');
    const expiry = addDays(data.produced_at,Number(p.rows[0].shelf_life_days)-1);
    if (expiry < businessDay()) throw new HttpError(400,'This batch would already be expired');
    const batch = await c.query('INSERT INTO batches(product_id,produced_qty,produced_at,expires_at,created_by) VALUES($1,$2,$3,$4,$5) RETURNING *',[data.product_id,data.produced_qty,data.produced_at,expiry,req.user.id]);
    for (const r of recipe.rows) await consume(c,'ingredient',Number(r.ingredient_id),Math.round(Number(r.qty_per_packet)*data.produced_qty*1000)/1000,'production_use',batch.rows[0].id,req.user.id);
    const lot = await c.query('INSERT INTO product_lots(batch_id,product_id,expires_at,remaining_qty) VALUES($1,$2,$3,$4) RETURNING *',[batch.rows[0].id,data.product_id,expiry,data.produced_qty]);
    await movement(c,'product',data.product_id,lot.rows[0].id,data.produced_qty,'production_output',batch.rows[0].id,req.user.id);
    return batch.rows[0];
  });
  res.status(201).json(result);
}));

const orderSchema = z.object({ customer_name:text, phone:text, due_date:day, fulfillment:z.enum(['pickup','delivery']), address:z.string().trim().max(300).optional(), notes:z.string().trim().max(1000).default(''), items:z.array(z.object({ product_id:id, quantity:z.coerce.number().int().positive() })).min(1) });
app.get('/api/orders', route(async (_req, res) => {
  const result = await db.query(`SELECT o.*,COALESCE((SELECT json_agg(json_build_object('product_id',oi.product_id,'sweet_name',p.sweet_name,'variant',p.variant,'quantity',oi.quantity,'unit_price',oi.unit_price) ORDER BY oi.id) FROM order_items oi JOIN products p ON p.id=oi.product_id WHERE oi.order_id=o.id),'[]'::json) AS items FROM orders o ORDER BY CASE WHEN o.status='confirmed' THEN 0 ELSE 1 END,o.due_date,o.id DESC LIMIT 200`);
  res.json(result.rows);
}));
app.post('/api/orders', route(async (req, res) => {
  const data = orderSchema.parse(req.body);
  if (data.fulfillment === 'delivery' && !data.address) throw new HttpError(400,'Delivery address is required');
  if (new Set(data.items.map(i => i.product_id)).size !== data.items.length) throw new HttpError(400,'Add each packet variant once');
  const result = await transaction(async c => {
    const products = await c.query('SELECT id,price FROM products WHERE id=ANY($1::bigint[]) AND active=true',[data.items.map(i=>i.product_id)]);
    if (products.rows.length !== data.items.length) throw new HttpError(400,'Select active packet variants');
    const prices = new Map(products.rows.map(p=>[Number(p.id),Number(p.price)]));
    const total = data.items.reduce((sum,i)=>sum + i.quantity*prices.get(i.product_id)!,0);
    const order = await c.query('INSERT INTO orders(customer_name,phone,due_date,fulfillment,address,notes,total,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',[data.customer_name,data.phone,data.due_date,data.fulfillment,data.address || null,data.notes,total,req.user.id]);
    for (const item of data.items) await c.query('INSERT INTO order_items(order_id,product_id,quantity,unit_price) VALUES($1,$2,$3,$4)',[order.rows[0].id,item.product_id,item.quantity,prices.get(item.product_id)]);
    return order.rows[0];
  });
  res.status(201).json(result);
}));
app.patch('/api/orders/:id/paid', route(async (req, res) => {
  const paid = z.boolean().parse(req.body.paid);
  const result = await db.query('UPDATE orders SET paid=$1 WHERE id=$2 AND status<>$3 RETURNING *',[paid,id.parse(req.params.id),'cancelled']);
  if (!result.rows[0]) throw new HttpError(404,'Active order not found');
  res.json(result.rows[0]);
}));
app.post('/api/orders/:id/cancel', route(async (req, res) => {
  const result = await db.query("UPDATE orders SET status='cancelled' WHERE id=$1 AND status='confirmed' RETURNING *",[id.parse(req.params.id)]);
  if (!result.rows[0]) throw new HttpError(409,'Only confirmed orders can be cancelled');
  res.json(result.rows[0]);
}));
app.post('/api/orders/:id/fulfill', route(async (req, res) => {
  const result = await transaction(async c => {
    const order = await c.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE',[id.parse(req.params.id)]);
    if (!order.rows[0]) throw new HttpError(404,'Order not found');
    if (order.rows[0].status !== 'confirmed') throw new HttpError(409,'Only confirmed orders can be fulfilled');
    const items = await c.query('SELECT product_id,quantity FROM order_items WHERE order_id=$1 ORDER BY product_id',[order.rows[0].id]);
    for (const item of items.rows) await consume(c,'product',Number(item.product_id),Number(item.quantity),'fulfillment',order.rows[0].id,req.user.id);
    const updated = await c.query("UPDATE orders SET status='fulfilled' WHERE id=$1 RETURNING *",[order.rows[0].id]);
    return updated.rows[0];
  });
  res.json(result);
}));

app.get('/api/dashboard', route(async (_req, res) => {
  const today = businessDay();
  const [products,ingredients,orders,production] = await Promise.all([
    db.query(`SELECT p.id,p.sweet_name,p.variant,p.sku,p.active,p.daily_target,p.low_stock,COALESCE(t.target_qty,p.daily_target) AS target_today,COALESCE((SELECT SUM(remaining_qty) FROM product_lots l WHERE l.product_id=p.id AND l.expires_at >= $1),0) AS stock,COALESCE((SELECT SUM(quantity) FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE oi.product_id=p.id AND o.status='confirmed'),0) AS committed,COALESCE((SELECT SUM(produced_qty) FROM batches b WHERE b.product_id=p.id AND b.produced_at=$1),0) AS made_today FROM products p LEFT JOIN target_overrides t ON t.product_id=p.id AND t.production_date=$1 ORDER BY p.sweet_name,p.variant`,[today]),
    db.query(`SELECT i.id,i.name,i.unit,i.low_stock,COALESCE((SELECT SUM(remaining_qty) FROM ingredient_lots l WHERE l.ingredient_id=i.id AND l.expires_at >= $1),0) AS stock FROM ingredients i WHERE i.active=true ORDER BY i.name`,[today]),
    db.query("SELECT id,customer_name,due_date,total,fulfillment FROM orders WHERE status='confirmed' AND due_date <= $1 ORDER BY due_date,id LIMIT 20",[addDays(today,2)]),
    db.query('SELECT COALESCE(SUM(produced_qty),0) AS packets FROM batches WHERE produced_at=$1',[today])
  ]);
  res.json({ today, products:products.rows, ingredients:ingredients.rows, due_orders:orders.rows, packets_today:production.rows[0].packets });
}));
app.get('/api/movements', route(async (_req, res) => {
  const result = await db.query(`SELECT m.*,m.reason || CASE WHEN m.note='' THEN '' ELSE ': ' || m.note END AS reason,u.name AS actor,CASE WHEN m.stock_type='ingredient' THEN i.name ELSE p.sweet_name || ' / ' || p.variant END AS item_name FROM stock_movements m JOIN users u ON u.id=m.created_by LEFT JOIN ingredients i ON m.stock_type='ingredient' AND i.id=m.item_id LEFT JOIN products p ON m.stock_type='product' AND p.id=m.item_id ORDER BY m.id DESC LIMIT 200`);
  res.json(result.rows);
}));
app.post('/api/adjustments', owner, route(async (req, res) => {
  const data = z.object({ stock_type:z.enum(['ingredient','product']), lot_id:id, delta:z.coerce.number().refine(v=>v !== 0), note:text }).parse(req.body);
  if (data.stock_type === 'product' && !Number.isInteger(data.delta)) throw new HttpError(400,'Packet adjustment must be a whole number');
  const result = await transaction(async c => {
    const table = data.stock_type === 'ingredient' ? 'ingredient_lots' : 'product_lots';
    const column = data.stock_type === 'ingredient' ? 'ingredient_id' : 'product_id';
    const lot = await c.query(`SELECT id,${column} AS item_id,remaining_qty FROM ${table} WHERE id=$1 FOR UPDATE`,[data.lot_id]);
    if (!lot.rows[0]) throw new HttpError(404,'Lot not found');
    if (Number(lot.rows[0].remaining_qty)+data.delta < 0) throw new HttpError(409,'Adjustment would make stock negative');
    await c.query(`UPDATE ${table} SET remaining_qty=remaining_qty+$1 WHERE id=$2`,[data.delta,data.lot_id]);
    await movement(c,data.stock_type,Number(lot.rows[0].item_id),data.lot_id,data.delta,'adjustment',data.lot_id,req.user.id,data.note);
    return { ok:true, note:data.note };
  });
  res.json(result);
}));
app.get('/api/lots', owner, route(async (_req, res) => {
  const [a,b] = await Promise.all([db.query('SELECT l.id,\'ingredient\' AS stock_type,i.name AS item_name,l.remaining_qty,l.expires_at FROM ingredient_lots l JOIN ingredients i ON i.id=l.ingredient_id WHERE l.remaining_qty>0 ORDER BY l.expires_at'),db.query("SELECT l.id,'product' AS stock_type,p.sweet_name || ' / ' || p.variant AS item_name,l.remaining_qty,l.expires_at FROM product_lots l JOIN products p ON p.id=l.product_id WHERE l.remaining_qty>0 ORDER BY l.expires_at")]);
  res.json([...a.rows,...b.rows]);
}));
app.get('/api/users', owner, route(async (_req,res) => { const r=await db.query('SELECT id,name,email,role,created_at FROM users ORDER BY id'); res.json(r.rows); }));
app.post('/api/users', owner, route(async (req,res) => {
  const data=z.object({ name:text,email:z.string().email(),password:z.string().min(12),role:z.enum(['owner','staff']) }).parse(req.body);
  const hash=await bcrypt.hash(data.password,12);
  const r=await db.query('INSERT INTO users(name,email,password_hash,role) VALUES($1,$2,$3,$4) RETURNING id,name,email,role',[data.name,data.email.toLowerCase(),hash,data.role]);
  res.status(201).json(r.rows[0]);
}));

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');
app.use(express.static(root));
app.get('*', (req,res,next) => req.path.startsWith('/api') ? next(new HttpError(404,'API route not found')) : res.sendFile(path.join(root,'index.html')));
app.use((error:Error, _req:Request, res:Response, _next:NextFunction) => {
  if (error instanceof ZodError) return res.status(400).json({ error:error.issues.map(i=>`${i.path.join('.')}: ${i.message}`).join('; ') });
  if (error instanceof HttpError) return res.status(error.status).json({ error:error.message });
  if ('code' in error && (error as { code:string }).code === '23505') return res.status(409).json({ error:'A record with this name or SKU already exists' });
  console.error(error);
  return res.status(500).json({ error:'Server error. Please try again' });
});
app.listen(Number(process.env.PORT || 4000), () => console.log(`Mavya API listening on ${process.env.PORT || 4000}`));
