# SweetLedger MVP specification

## Purpose and users

An owner manages sweet packet variants, recipes, prices, normal daily targets, and staff accounts. Staff receive ingredients, record production, enter phone/walk-in/message orders, and fulfill them. The app uses NPR, Asia/Kathmandu business dates, and day/month/year display. It is an internal, hosted web app; customers do not log in.

## Workflows

1. **Setup:** Owner creates ingredients and packet variants. Each variant has one SKU, fixed packet price, shelf life, normal daily target, and recipe quantities per packet. Seasonal variants can be made inactive without deleting history.
2. **Receive:** Staff enters ingredient, supplier, quantity, unit cost, and expiry. A receipt creates a lot and positive stock movement. Expired lots are excluded from usable stock.
3. **Plan and produce:** Today's board displays normal targets or owner overrides, completed production, open order demand, and usable packet stock. Staff records a batch for one variant and quantity. The system consumes usable ingredient lots by earliest expiry, then creates a packet lot expiring after the configured shelf life. The whole action is one database transaction; insufficient ingredients reject it without partial changes.
4. **Order and fulfill:** Staff enters customer, phone, due date, pickup/delivery, packet quantities, and optional notes. Prices are copied from the catalog into the order. Confirmed orders count toward demand but do not reduce stock. Fulfillment consumes usable packet lots by earliest expiry in one transaction; shortages reject it. Orders can be marked paid or cancelled before fulfillment.
5. **Monitor:** Dashboard shows due soon orders, packet shortages against confirmed orders, low usable ingredient and packet stock, and today's production. Movement history keeps receipt, batch, fulfillment, and adjustment records.

## Rules and acceptance

- All stock-changing writes use PostgreSQL transactions and row locks. Quantity is never negative. Expired lots never count as usable or fulfill an order.
- Product variants can be inactive while prior batches and orders remain readable. New orders and batches require active variants.
- Owner-only changes: staff accounts, catalog, recipes, daily targets, and stock adjustments. Staff can create receipts, batches, and orders, mark paid, cancel, and fulfill.
- Production and fulfillment record movements once. Repeating a fulfillment request cannot consume stock twice.
- Dashboard reflects newly received lots, completed batches, open orders, and expiries. Forms explain validation and shortage errors.
- No online shop, automated forecasting, purchase orders, invoices, or multi-location inventory in the MVP.

## Later phases

1. Customer storefront and online payment reuse catalog and order records.
2. Seasonal planning calendar and historical demand suggestions.
3. Purchase orders, cost reporting, and multiple stock locations when needed.
