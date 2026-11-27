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

The unauthenticated `GET /api/health` endpoint checks API and database availability. It returns `status: ok` when both are working and the deployed commit in `version` on Render; use a non-200 response to trigger a deployment alert. Configure automated PostgreSQL backups with the database host, and regularly restore a backup into a separate database to verify it. The application does not schedule backups itself.

The development UI proxies `/api` to the API on port 4000. For a single service deployment, run `npm run build` and `npm start`; Express serves the built UI. Set `DATABASE_URL` and the secrets in the host environment, run `npm run db:setup` before starting, and use HTTPS. Run `pg_dump` regularly for backups.

## GitHub Actions deployment

Pull requests to `main` run typecheck, unit tests, a production build, and the full API workflow against a temporary PostgreSQL database. A push to `main` runs the same checks, then requests a Render API deploy for that exact commit. The workflow waits for Render's health endpoint to report that commit before building and deploying the Vercel frontend. You can also run the workflow manually from GitHub Actions on `main`.

Before the first deployment, add these **repository secrets** under GitHub → Settings → Secrets and variables → Actions:

- `RENDER_DEPLOY_HOOK_URL`: copy the deploy hook from the existing Mavya service in Render → Settings. Keep the full URL private.
- `VERCEL_TOKEN`: create a Vercel access token with access to the `abhishek-404/mavya` project. The workflow already contains its non-secret organization and project IDs.

Set Render's Auto-Deploy to **Off** so each push does not start a second deploy before checks pass. Vercel Git auto-deploy is disabled in `vercel.json`; the Action creates the production deployment after checks pass. Keep `DATABASE_URL`, `JWT_SECRET`, and the owner credentials configured on Render; GitHub Actions does not need production database credentials. The first run will fail with a clear missing-secret message until both repository secrets are saved.

## Stack

React, Vite, TypeScript, Express, PostgreSQL. See [MVP specification](docs/mvp-spec.md) for workflows and acceptance criteria.
