# Development guide

This guide covers the Veyra source repository. Product behavior is described in [the product definition](docs/PRODUCT_DEFINITION.md); current implementation and limitations are in [the product status](docs/PRODUCT_STATUS.md).

## Local development

Use Node.js 22 or newer, pnpm, PostgreSQL, and the root `.env.local` described in the [README](README.md#configure-environment). Install dependencies from the repository root with `corepack pnpm install`.

Run the API and frontend in separate terminals:

```sh
corepack pnpm --filter @workspace/api-server run dev
corepack pnpm --filter @workspace/trezu run dev
```

The API listens on `PORT` (normally 3000). The Vite app listens on port 5173 and proxies `/api` to `http://localhost:3000` unless `API_PROXY_TARGET` is set. The API needs a reachable PostgreSQL database. Authentication requires matching Privy app configuration for the browser and server. Google SMTP is required for delivered signup, invitation, and invoice notifications. Tidepool availability is required for provider quotes and settlement status.

## Before opening a change

1. Keep `.env.local`, signing material, access tokens, database URLs, and real user data out of commits.
2. Review the complete diff, including generated API types and SQL migrations.
3. Run the relevant frontend/API typecheck and build commands from the README.
4. Describe testnet behavior as testnet behavior. A quote, wallet approval, or pending deposit is not proof of settlement.
5. Update the product status when a user-visible workflow or an external integration changes.

## Data and migrations

Drizzle schema is in `lib/db/src/schema/`. SQL migrations are in `lib/db/migrations/`. Migration helper scripts under `scripts/` can apply changes directly to the database selected by `DATABASE_URL`; inspect each script and confirm the target before running it.

## Source layout

- `artifacts/trezu/src/` — app screens, styles, and wallet integrations.
- `artifacts/api-server/src/` — API routes, auth, mail, and payment-provider logic.
- `lib/db/src/schema/` — persistent data model.
- `lib/api-spec/openapi.yaml` — API definition.
