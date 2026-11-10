# Trezu

Trezu is a global financial workspace for freelancers and remote businesses to manage invoices, payroll setup, treasury preferences, approved local exchange vendors, and financial records.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- Web: React, Vite, Wouter, TanStack Query
- Authentication: Replit-managed Clerk
- API: Express 5 with Clerk session authentication
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod and generated OpenAPI schemas
- API codegen: Orval from `lib/api-spec/openapi.yaml`
- Build: Vite for the web app, esbuild for the API

## Where things live

- `artifacts/trezu/` — Trezu public site and authenticated finance workspace
- `artifacts/api-server/src/routes/trezu/` — authenticated workspace API routes
- `lib/db/src/schema/` — workspace, invoice, employee, vendor, audit, and ledger tables
- `lib/api-spec/openapi.yaml` — API contract source of truth
- `artifacts/trezu/src/index.css` — shared web theme

## Architecture decisions

- Browser and API authentication use Clerk session cookies. Financial API routes must enforce workspace membership and role checks on the server.
- Money is stored as PostgreSQL numeric and accepted as decimal strings. Do not convert financial values to JavaScript floating point for calculations.
- The ledger has an idempotency key and external provider reference. Record funds only after a provider verifies settlement.
- Treasury allocations are preferences only until an actual movement provider is configured. Never imply that saving a percentage moves funds.
- The exchange marketplace is limited to manually approved vendors. Fiat settlement is direct between the user and vendor, not an assumed API transfer.

## Product

The product is organized as one workspace across invoices, payroll, treasury, vendor exchange, and financial records. The first implementation supports account setup, invoice drafts, employee compensation profiles, saved allocation preferences, and vendor applications/listings. Wallet connection, payments, payroll execution, automatic fund movement, disputes, and downloadable financial documents require additional service work and must not be represented as completed until wired to verified providers.

## User preferences

- Do not use em dashes in Trezu copy or UI.

## Gotchas

- After any change to `lib/api-spec/openapi.yaml`, rerun `pnpm --filter @workspace/api-spec run codegen`.
- Use Clerk's `/sign-in/*?` and `/sign-up/*?` routes and the artifact base path in all auth URLs.
- The web app and API share an origin, so browser API requests use Clerk cookies and must not add bearer-token handling.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
