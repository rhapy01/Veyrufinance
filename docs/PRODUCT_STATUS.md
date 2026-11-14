# Veyra Finance implementation status

Last reviewed: 13 November 2026

This is a current-state reference, not a roadmap or a transaction-success claim. See [the product definition](PRODUCT_DEFINITION.md) for user roles and intended workflows.

## Product

Veyra Finance is a non-custodial global payments and finance workspace for freelancers and organizations. Its core workflow connects invoice creation, cross-network payment, provider-confirmed receipt, supplier payments, and organization payroll. A payer chooses a supported source asset; the recipient specifies the desired settlement asset, network, and receiving address. Veyra coordinates quotes, wallet approval, and status tracking. Funds are controlled by the wallets involved and are not held by Veyra.

## Implemented areas

- **Authentication and workspaces:** Privy is the primary authentication provider. Veyra keeps its own user, workspace, and membership records for product permissions. Direct signups choose a freelancer or organization starting workspace. Accepting an organization invitation automatically creates a personal freelancer workspace when the invited account does not already have one, while retaining employee membership in the organization. Users can switch between these separate workspaces; organization membership does not turn an employee's personal wallet into a shared organization wallet.
- **Invoices:** registered users can create and send invoices to an existing Veyra account. Guest issuers can create invoices without a Veyra account, but the intended recipient must have an account. Invoice email is a notification; the invoice is stored in the recipient's Received invoices view. The invoice captures its receiving asset, network, and wallet. Checkout supports choosing a source asset and payment amount, subject to the live provider catalog and quote.
- **Invoice payment records:** the invoice and its payment attempts retain provider status and transaction references. Partial payments are reflected against the remaining invoice amount. A quote or submitted deposit is not marked paid until provider settlement is confirmed and matched.
- **Organization and payroll:** organization owners/admins invite team members and manage their compensation and payout preferences. They prepare a pay cycle, review its staff and amount, and initiate wallet-signed payouts. Approval of the plan alone does not send funds. Each employee payout is tracked against provider settlement; payslips depend on a confirmed payout.
- **Bills to pay:** a derived view of incoming invoices and payroll obligations, not a separate vendor bill-import workflow. Users return to the original invoice or payroll flow to review and pay.
- **Wallets:** Privy provides the embedded wallet experience configured for this app, with NEAR and supported EVM testnet wallet integrations. Wallet balances and signing belong to the current wallet owner. The person initiating a payment must use their own compatible wallet and cover its transfer, network, and token-storage requirements.
- **Treasury and records:** workspace records and allocation preferences help organize confirmed income. Current allocation/ledger entries are internal records; they do not themselves execute transfers or automatically send income to another address or DeFi protocol.
- **Local Exchange and P2P:** unavailable in this build and should be presented as Coming soon.

## Network and provider boundary

- The product configuration in this repository is for **testnet use**. NEAR account checks and NEAR wallet transactions use NEAR testnet; supported EVM transactions use test chains provided by the current asset routes.
- The server's Intents-compatible API base is `https://www.usetidepool.tech/v0`. Tidepool is a community-run testnet sandbox; it is **not an official first-party NEAR Intents testnet**. The repository deliberately does not use the production 1Click API. Provider endpoints, available tokens, route support, fees, and uptime can change.
- Testnet tokens are not real money. A successful wallet signature is not a settlement result. The provider's confirmed status and reconciliation to the expected recipient/asset/amount determine whether Veyra records payment as complete.
- Quotes can expire or remain awaiting deposit. Stale or failed quotes must not be shown as successful financial activity.
- NEAR FT payments may require the payer's wallet to hold both the selected fungible token and native NEAR for gas or storage registration. A NEAR account must also exist on-chain and have an active signing key for the selected wallet.
- Organization payroll can require multiple provider quotes and wallet transactions. A pay run is a set of related per-person payments, not one atomic blockchain transaction; never promise one approval for arbitrary sizes or routes.

## Not available or not automated

- Mainnet payment mode, production 1Click credentials, and real-value transfers.
- Veyra custody, escrow, or a Veyra-owned smart contract.
- Automatic income splitting or transfers from a receiving wallet based only on a saved Treasury preference.
- Recurring unattended payroll, fiat conversion/local exchange, and P2P execution.
- Sending an invoice to a recipient who has not registered for Veyra.
- Treating invoice creation, a quote, wallet approval, or a pending provider deposit as a completed payment.

## Local configuration

The local app expects a root `.env.local` file, ignored by Git. Important server settings include:

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection used by the API and schema tooling |
| `PORT` | API listen port; normally `3000` |
| `WEB_APP_URL` | Browser app URL used for generated invoice and invitation links |
| `PRIVY_APP_ID` | Server-side Privy application ID |
| `VITE_PRIVY_APP_ID` | Matching Privy application ID exposed to the frontend |
| `PRIVY_APP_SECRET` | Server-side Privy verification credential; never expose to Vite or commit |
| `SMTP_USER`, `SMTP_PASS` | Gmail address and Google App Password for email delivery |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE` | Optional SMTP connection overrides; default host is `smtp.gmail.com`, port `465` |
| `AUTH_FROM_EMAIL` | Optional sender address; defaults to `SMTP_USER` |
| `NEAR_INTENTS_JWT` | Optional bearer credential for Tidepool's authenticated fee tier |
| `NEAR_INTENTS_STATUS_POLL_MS` | Optional provider reconciliation interval; minimum 15 seconds |
| `AUTH_SIGNING_DOMAIN` | Optional NEP-413 wallet-link signing domain |
| `TREZU_PLATFORM_ADMIN_USER_IDS` | Optional list of privileged Veyra user IDs |

The frontend also recognizes `API_PROXY_TARGET` for the Vite `/api` proxy. Do not put secrets in `VITE_*` variables. See [README local setup](../README.md#run-locally).

## Repository layout

- `artifacts/trezu/` — React/Vite frontend and wallet integrations.
- `artifacts/api-server/` — Express API, Privy verification, email, invoice, payroll, records, and Tidepool workflows.
- `lib/db/` — PostgreSQL/Drizzle schema and migrations.
- `lib/api-spec/` — OpenAPI contract and generated API clients/schemas.
- `scripts/` — migration helpers and workspace scripts. Inspect scripts and database target before execution.

## Verification record

The prior implementation notes recorded successful frontend typecheck/build, API bundle build, and local smoke flows for employee onboarding, payroll quote preparation, and invoice asset/quote creation. Those notes did not submit wallet deposits or simulate provider-confirmed settlement. Re-run the relevant checks against the current checkout before relying on those results; this document is not a claim that the present working tree has been revalidated end to end.

For current run commands and checks, see [DEVELOPMENT.md](../DEVELOPMENT.md).
