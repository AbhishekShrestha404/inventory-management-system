import test from 'node:test';
import assert from 'node:assert/strict';
process.env.DATABASE_URL ||= 'postgres://unused:unused@127.0.0.1:5432/unused';
const { addDays, businessDay } = await import('../dist/db.js');

test('packet shelf life crosses month and leap day correctly', () => {
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(addDays('2028-02-28', 3), '2028-03-02');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
});

test('business date follows the Kathmandu calendar', () => {
  const expected = new Intl.DateTimeFormat('en-CA', { timeZone:'Asia/Kathmandu', year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date());
  assert.equal(businessDay(), expected);
  assert.match(businessDay(), /^\d{4}-\d{2}-\d{2}$/);
});
