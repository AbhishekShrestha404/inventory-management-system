# Mavya

An internal inventory and order system for a small sweet factory. Staff can receive ingredients, produce packet batches, and fulfill manually entered orders. The owner can manage recipes, prices, targets, and users.

## Run locally

1. Run `cp .env.example .env` in the project root. Replace the example `JWT_SECRET`, `OWNER_EMAIL`, and `OWNER_PASSWORD` with your own values. Keep the example `DATABASE_URL` for the included Docker database.
2. Start PostgreSQL: `docker compose up -d db`.
3. Install dependencies: `npm install`.
4. Create the schema and first owner: `npm run db:setup`.
5. Start the API and web app: `npm run dev`.
6. Open `http://localhost:5173`.

To check the full API workflow against an isolated temporary database, keep PostgreSQL running and run `npm run test:smoke`. The test creates and removes its own database; it does not change the working Mavya data.

The development UI proxies `/api` to the API on port 4000. For a single service deployment, run `npm run build` and `npm start`; Express serves the built UI. Set `DATABASE_URL` and the secrets in the host environment, run `npm run db:setup` before starting, and use HTTPS. Run `pg_dump` regularly for backups.

## Stack

React, Vite, TypeScript, Express, PostgreSQL. See [MVP specification](docs/mvp-spec.md) for workflows and acceptance criteria.
