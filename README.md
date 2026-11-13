# Veyra Finance

**Pay across chains. Run your business.**

Veyra Finance is a global payments and finance workspace for freelancers and teams. It brings invoicing, cross-network payments, team payroll, and financial records into one place. The payer chooses an asset they hold; the invoice states the asset, network, and wallet the recipient wants. The payer reviews the route and approves it from their own wallet. Veyra coordinates the workflow and records the result, but does not hold customer funds.

> **Current environment:** This is a testnet prototype. NEAR wallets and EVM wallets use test networks. NEAR Intents-style quote and settlement testing is routed through Tidepool, an independent community sandbox. There is no official first-party NEAR Intents testnet. Test tokens have no monetary value. Do not use mainnet funds with this build.

## What you can do

- **Sign in and create a workspace.** Privy is the primary sign-in provider and provisions embedded wallets where configured. Workspace membership and permissions remain Veyra application records; a wallet is not a second Veyra account.
- **Create and send invoices.** Create an invoice from a form, choose the receiving asset and network, enter the recipient’s registered Veyra email, and send it. The recipient sees it in Received invoices; email is a notification. Guest invoice creation is available, but the recipient still needs an account.
- **Pay an invoice.** Open the received invoice, choose a supported source asset and the amount to pay, review the quote, approve the transaction with your wallet, then follow provider settlement. Partial payment is supported where the provider route supports it.
- **Prepare team payroll.** Organization owners/admins invite staff, maintain each person’s compensation and payout preference, create a pay run, review the total, and approve payouts from the owner’s wallet. Employees see their organization membership and pay information; ordinary members do not get payroll administration.
- **Review records and treasury preferences.** Records reflect saved invoices, payment states, transaction references, and payroll activity. Treasury contains allocation preferences and internal records. Saving an allocation does not itself move funds or automatically route future income.
- **Manage wallets.** View available wallet addresses and balances. Payments are signed by the relevant user’s wallet; the owner’s personal wallet is not a shared team wallet.

## How payment status works

Creating an invoice or quote does not move money. Wallet approval submits a deposit transaction. Veyra records a payment as complete only after the provider confirms settlement and the result is reconciled to the invoice or payroll payment. A quote waiting for a deposit is not a successful payment. On NEAR, token payments may also need native NEAR for network or token-storage fees.

## Current boundaries

- **Testnet only.** The app is configured for test networks, including NEAR testnet and supported EVM testnets. It does not provide a mainnet switch.
- **Tidepool is not an official NEAR Intents testnet.** Tidepool is the community-operated testnet sandbox used by this prototype for compatible quote and status workflows. Provider availability, test assets, and routes can change independently of Veyra.
- **No Veyra custody or contract.** Veyra does not custody funds, deploy a Veyra payment contract, or escrow invoice proceeds. The receiving wallet saved on an invoice receives its settlement asset directly through the provider route.
- **Approval is not payroll settlement.** A pay run stores the plan. The owner must have the source asset and approve the quoted payments. Provider-confirmed results are tracked per employee. Network or provider limits may require more than one wallet approval for a large run.
- **Treasury automation is limited.** Allocation preferences and ledger classifications are application records. Automatic on-chain splitting, recurring payroll, local exchange, and P2P trading are not available in this build.
- **Email and external services need configuration.** Account email delivery uses Google SMTP. Privy, PostgreSQL, and Tidepool connectivity are required for their respective features.

## Run locally

### Requirements

- Node.js 22 or newer
- pnpm (use Corepack if pnpm is not installed)
- A PostgreSQL database
- A Privy application configured for the local app URL
- For email delivery, a Google SMTP account with a Google App Password

### Configure environment

Create a root `.env.local` file. Keep credentials private and never commit it. The Vite app reads this root file, and the API loads it when started from its package directory.

```dotenv
PORT=3000
DATABASE_URL=postgresql://USER:PASSWORD@HOST/DATABASE?sslmode=require
WEB_APP_URL=http://localhost:5173

# Privy
PRIVY_APP_ID=your-privy-app-id
VITE_PRIVY_APP_ID=your-privy-app-id
PRIVY_APP_SECRET=your-privy-app-secret

# Google SMTP (needed for account and invoice email)
SMTP_USER=you@example.com
SMTP_PASS=your-google-app-password
# Optional: SMTP_HOST=smtp.gmail.com
# Optional: SMTP_PORT=465
# Optional: SMTP_SECURE=true
# Optional: AUTH_FROM_EMAIL=you@example.com

# Optional Tidepool lower-fee authentication
# NEAR_INTENTS_JWT=your-tidepool-token
```

`DATABASE_URL`, `PORT`, and Privy credentials are required for a normal authenticated run. SMTP credentials are required to deliver email. `NEAR_INTENTS_JWT` is optional; without it, Tidepool applies its unauthenticated fee schedule. Do not put server secrets in variables prefixed with `VITE_`.

### Install and start

From the repository root:

```sh
corepack pnpm install
```

Start the API in one terminal:

```sh
corepack pnpm --filter @workspace/api-server run dev
```

Start the frontend in a second terminal:

```sh
corepack pnpm --filter @workspace/trezu run dev
```

Open [http://localhost:5173](http://localhost:5173). The frontend proxies `/api` requests to `http://localhost:3000` by default. The API requires `PORT=3000` and a reachable database. Confirm the API responds at [http://localhost:3000/](http://localhost:3000/).

### Useful commands

```sh
corepack pnpm --filter @workspace/trezu typecheck
corepack pnpm --filter @workspace/trezu build
corepack pnpm --filter @workspace/api-server build
corepack pnpm typecheck
```

Database schema lives in `lib/db/src/schema/`; SQL migrations live in `lib/db/migrations/`. Review the migration contents and target database before applying them.

## Repository map

| Path | Contents |
| --- | --- |
| `artifacts/trezu/` | React/Vite application, public pages, authenticated workspace, and wallet integrations |
| `artifacts/api-server/` | Express API, Privy token verification, email delivery, invoices, payroll, records, and payment-provider workflows |
| `lib/db/` | PostgreSQL connection, Drizzle schema, and migrations |
| `lib/api-spec/` | OpenAPI contract |
| `lib/api-client-react/`, `lib/api-zod/` | Generated and shared API client types |
| `docs/PRODUCT_DEFINITION.md` | Product roles, workflows, and intended behavior |
| `docs/PRODUCT_STATUS.md` | Current implementation, configuration, and known limitations |
| `DEVELOPMENT.md` | Local development and contribution notes |

## NEAR HACKATHON context

Veyra is an existing finance-workspace product. The hackathon-relevant work is the NEAR-facing invoice and payroll payment path: selecting assets across networks, obtaining a provider quote, signing from the user’s wallet, and tracking the provider result. The current demonstrable integration uses the Tidepool community sandbox on testnet; it should not be described as an official NEAR Intents testnet or as a mainnet integration. Explain which work was built during the hackathon window and identify pre-existing product functionality in the project demo and submission.

The submission rules require a public repository, a public X demo post that says the project was built at NEAR HACKATHON and tags `@NEARProtocol` and `#NEARHackathon`, and both links submitted through the official form. The stated deadline is **14 November 2026 at 23:59 UTC**. Read the [official rules](https://nearhackathon.com/HACKATHON.md) again before submitting; the rules are authoritative and may change.

## Product and developer docs

- [Product definition](docs/PRODUCT_DEFINITION.md)
- [Implementation status and limitations](docs/PRODUCT_STATUS.md)
- [Development guide](DEVELOPMENT.md)
- [MIT License](LICENSE)
