# Veyra Finance

**Pay across chains. Run your business.**

Veyra Finance is a global payments and finance workspace for freelancers and teams, built around **NEAR Intents**. It brings invoicing, cross-network payments, team payroll, and financial records into one place. The payer chooses an asset they hold; the invoice states the asset, network, and wallet the recipient wants. NEAR Intents routes the payment between supported assets and networks. The payer reviews the quote and approves it from their own wallet. Veyra coordinates the workflow and records the result, but does not hold customer funds.

> **Current environment:** This is a testnet prototype. NEAR wallets and EVM wallets use test networks. NEAR Intents-style quote and settlement testing is routed through Tidepool, an independent community sandbox. There is no official first-party NEAR Intents testnet. Test tokens have no monetary value. Do not use mainnet funds with this build.

## What you can do

- **Keep personal and organization work separate.** Direct signups choose whether to start as a freelancer or create an organization. Joining through an organization invitation automatically gives the account a personal freelancer workspace as well; the person can send invoices and use Veyra independently without losing their organization membership. Existing personal freelancer workspaces are kept, not duplicated. Privy is the primary sign-in provider and provisions embedded wallets where configured.
- **Create and send invoices.** Create an invoice from a form, choose the receiving asset and network, enter the recipient’s registered Veyra email, and send it. The recipient sees it in Received invoices; email is a notification. Guest invoice creation is available, but the recipient still needs an account.
- **Pay an invoice.** Open the received invoice, choose a supported source asset and the amount to pay, review the quote, approve the transaction with your wallet, then follow provider settlement. Partial payment is supported where the provider route supports it.
- **Prepare team payroll.** Organization owners/admins invite staff, maintain each person’s compensation and payout preference, create a pay run, review the total, and approve payouts from the owner’s wallet. Employees see their organization membership and pay information; ordinary members do not get payroll administration.
- **Review records and treasury preferences.** Records reflect saved invoices, payment states, transaction references, and payroll activity. Treasury contains allocation preferences and internal records. Saving an allocation does not itself move funds or automatically route future income.
- **Manage wallets.** View available wallet addresses and balances. Payments are signed by the relevant user’s wallet; the owner’s personal wallet is not a shared team wallet.

## Completed testnet payment examples

These examples come from Veyra payment records marked **SUCCESS** by the provider and reconciled to the matching invoice or payroll item. The linked hashes are the recorded source and destination transactions; the Base Sepolia recipient transaction receipts were also checked and report successful execution. User names, email addresses, and wallet addresses are intentionally omitted.

| Payment | Settlement | Date (UTC) | Source transaction | Recipient transaction |
| --- | --- | --- | --- | --- |
| wNEAR on NEAR Testnet → USDT on Base Sepolia | 2.843466989554980530937695 wNEAR sent; 10 USDT received | 13 Nov 2026 | [NEAR transaction](https://testnet.nearblocks.io/txns/4dvfsZNNngLdFkcThqZMvbebCGUPqKPBdQsxyrL149uX) | [Base Sepolia transaction](https://sepolia.basescan.org/tx/0x1f56d8f907d03b5f42fe2c6cf4191a66edf9977530519ffc963c4836b4f2463e) |
| wNEAR on NEAR Testnet → USDC on Base Sepolia | 0.572119838418180996022288 wNEAR sent; 2 USDC received | 13 Nov 2026 | [NEAR transaction](https://testnet.nearblocks.io/txns/2uGpgX9tAdWJigZ24Nm5SufCwhV1K8rvCGrmPtvazQ1j) | [Base Sepolia transaction](https://sepolia.basescan.org/tx/0x5b1ddffb599e6e3dc3e89441e9fa4e802685b81323011f9f42e8c13fecaf1fc2) |
| **Organization payroll** · monthly pay run, payout 1 of 2 · **PAID** | 0.291165528366926504946908 wNEAR sent; 1.000522 USDC received for a USD 1.00 payroll item | 13 Nov 2026 | [NEAR transaction](https://testnet.nearblocks.io/txns/Czn9BF2WBWPy9xZpdC4rpZpah9hNVJGUCDtHEi4EYsmu) | [Base Sepolia transaction](https://sepolia.basescan.org/tx/0x2a4c7f4f0b8b3c913e2493ace7f62c7f3655a69b3ddbf9b50c58bf94adced8b7) |
| **Organization payroll** · monthly pay run, payout 2 of 2 · **SUBMITTED / PROCESSING** | Quote expected 0.294077183650595769996377 wNEAR → 1.000522 USDC; Tidepool reports an invalid destination address checksum, so settlement is not confirmed | Checked 14 Nov 2026 | Same recorded [NEAR source transaction](https://testnet.nearblocks.io/txns/Czn9BF2WBWPy9xZpdC4rpZpah9hNVJGUCDtHEi4EYsmu) | No Base Sepolia recipient transaction recorded yet |

The two payroll rows are from the same two-person monthly pay run. At the latest status check, payout 1 was confirmed and matched; payout 2 remained **PROCESSING** because its mixed-case EVM recipient address failed Tidepool's checksum validation. The exact address is omitted. No destination transaction or confirmed received amount exists for payout 2, so the overall pay run remained processing and must not be presented as fully paid. Tidepool's status documentation explains that a destination payout which keeps failing may stay in `PROCESSING` with an error note and require operator attention. These are testnet demonstrations, not real-money payments or a guarantee that every route is available. Provider confirmation and reconciliation are the basis for each paid status shown here.

### Payroll address validation lesson

This incident exposed an address-normalization gap: an EVM address with incorrect mixed-case EIP-55 capitalization passed into a provider quote and the resulting deposit reached Tidepool without a confirmed recipient payout. EVM address casing does not change the underlying wallet, but Tidepool's parser rejected that spelling. Payroll invitation acceptance, payout-profile saving, and quote preparation now normalize EVM addresses into canonical checksum form before requesting a new quote. This prevents a casing mismatch from blocking a new route; it does not repair or refund the already-submitted quote above. That payment remains unresolved until Tidepool completes settlement or returns the deposit to its refund address.

## How payment status works

Creating an invoice or quote does not move money. Wallet approval submits a deposit transaction. Veyra records a payment as complete only after the provider confirms settlement and the result is reconciled to the invoice or payroll payment. A quote waiting for a deposit is not a successful payment. On NEAR, token payments may also need native NEAR for network or token-storage fees.

## Current boundaries

- **Testnet only.** The app is configured for test networks, including NEAR testnet and supported EVM testnets. It does not provide a mainnet switch.
- **Tidepool is not an official NEAR Intents testnet.** Tidepool is the community-operated testnet sandbox used by this prototype for compatible quote and status workflows. Provider availability, test assets, and routes can change independently of Veyra.
- **No Veyra custody or contract.** Veyra does not custody funds, deploy a Veyra payment contract, or escrow invoice proceeds. The receiving wallet saved on an invoice receives its settlement asset directly through the provider route.
- **Approval is not payroll settlement.** A pay run stores the plan. The owner must have the source asset and approve the quoted payments. Provider-confirmed results are tracked per employee. Network or provider limits may require more than one wallet approval for a large run.
- **Treasury automation is limited.** Allocation preferences and ledger classifications are application records. Automatic on-chain splitting, recurring payroll, local exchange, and P2P trading are not available in this build.
- **Email and external services need configuration.** Account email delivery uses Google SMTP. Privy, PostgreSQL, and Tidepool connectivity are required for their respective features.

## Planned, not yet available

- **Full treasury automation.** The planned direction is for users to define how confirmed incoming funds should be allocated by percentage and destination, including their own wallets and supported DeFi protocols. Veyra should prepare the resulting actions from those preferences while keeping fund control and required wallet approvals with the user. Today, treasury preferences are saved records; they do not trigger automatic transfers.
- **Peer-to-peer marketplace for faster cash-out.** A planned marketplace will help users find counterparties to exchange supported digital assets for local payment. It is not live in this build; availability will depend on supported locations, counterparties, and liquidity.

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

Veyra Finance is a financial workspace for freelancers and organizations, powered by NEAR Intents. This submission demonstrates the invoice and organization-payroll payment flows: choosing supported assets across networks, obtaining a provider quote, approving from the payer’s wallet, and tracking settlement. Direct signups choose how to start; joining an organization through its invitation adds a personal freelancer workspace without replacing the organization membership. The demonstrable payment integration uses the Tidepool community sandbox on testnet; it is not an official NEAR Intents testnet or a mainnet integration. Describe the work and testnet boundaries accurately in the project demo and submission.

The public X demo post for this project is [Veyra Finance on X](https://x.com/IsaacXVoxel/status/2121521980075909593). The submission rules require a public repository, a public X demo post that says the project was built at NEAR HACKATHON and tags `@NEARProtocol` and `#NEARHackathon`, and both links submitted through the official form. The stated deadline is **14 November 2026 at 23:59 UTC**. Read the [official rules](https://nearhackathon.com/HACKATHON.md) again before submitting; the rules are authoritative and may change.

## Product and developer docs

- [Product definition](docs/PRODUCT_DEFINITION.md)
- [Implementation status and limitations](docs/PRODUCT_STATUS.md)
- [Development guide](DEVELOPMENT.md)
- [MIT License](LICENSE)
