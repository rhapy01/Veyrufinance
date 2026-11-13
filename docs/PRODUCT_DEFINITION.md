# Veyra Finance product definition

## What Veyra is

Veyra Finance (Veyra) is a global payments and finance workspace for freelancers and businesses that invoice, receive cross-network payments, and pay people or suppliers. Its tagline is **“Pay across chains. Run your business.”** NEAR Intents is the payment and payout rail: a payer can choose an asset they hold, while the invoice recipient specifies the asset, network, and wallet they want to receive.

The product promise is one clear record from **invoice → payment → confirmed receipt → next use of funds**. Veyra records and coordinates the workflow; wallet owners approve every on-chain deposit. Invoice proceeds go directly to the receiving wallet saved on the invoice. Veyra does not custody the funds.

The current application is a testnet product. Tidepool supplies its test Intents routes and assets; test tokens have no monetary value.

## Who uses Veyra

- **Freelancer:** creates and sends client invoices, receives payment to a chosen wallet, and reviews confirmed receipts and records.
- **Business owner or finance admin:** sends and receives invoices, prepares payroll, and reviews outstanding invoice and payroll obligations together in Bills to pay.
- **Invoice recipient:** any active Veyra account can receive an invoice in its Received invoices dashboard, whether the account is a freelancer or belongs to a team. They review it, choose a supported source asset and payment amount, approve the wallet transaction, and follow settlement.
- **Guest invoice issuer:** does not need a Veyra account to create an invoice. They provide their name, email, receiving asset/network/address, and the recipient’s registered Veyra email. They can track the invoice through its payment link and receive payment notices by email; they do not get a workspace or team-management tools.
- **Employee:** receives a business invitation, reviews pay history, and views confirmed payout details in the employee area. An employee account can also receive invoices; it does not expose business payroll administration.

## The main workflows

### Create and collect an invoice

1. A registered user creates an invoice inside their workspace, or a guest uses the public **Create an invoice** flow.
2. The invoice records the amount, line items, settlement asset, destination network and address, and due date/terms.
3. The sender enters the recipient’s registered Veyra email. Veyra adds the invoice to that user’s **Received invoices** list and emails a notification.
4. The recipient opens the invoice, chooses a supported source asset and how much to pay, reviews the quote, and approves the wallet transaction.
5. NEAR Intents delivers the requested settlement asset to the invoice destination. Veyra marks a payment confirmed only after provider settlement and invoice matching.
6. The sender follows paid amount, remaining balance, payment attempts, and explorer references from invoice details. Confirmed funds are already in the specified wallet and remain under that wallet owner’s control.

Invoice creation is a form, not a file-upload process. A guest issuer may create an invoice, but an unregistered recipient cannot receive it through Veyra.

### Use received funds

Veyra does not automatically move, pool, or reinvest invoice proceeds. The receiving wallet balance is the available money. From there:

- A supplier invoice sent to a registered Veyra account appears in Received invoices and Bills to pay. The business opens that invoice, chooses the source asset and amount, and approves the NEAR Intents payment from its wallet.
- A business can prepare payroll from saved employee records, review the pay period and totals, approve the cycle, prepare a quote for each employee, and approve the quoted deposits from its wallet. Those employee payments also appear in Bills to pay.
- A freelancer or business can use Treasury to record allocation preferences and confirmed income splits. Those entries are internal records; they do not create on-chain transfers.

### Prepare and pay payroll

1. Add an employee or import employee records: name, email, compensation, currency, pay frequency, preferred stablecoin/network, and destination wallet.
2. Choose a payroll period and planned pay date, then prepare a review.
3. Review and approve the cycle. Approval saves the pay instructions; it does not send money.
4. Prepare a NEAR Intents payout quote for each employee. Select the business source asset and refund address.
5. The business approves the quoted source deposit in its wallet. Veyra checks provider status and records each employee payment separately.
6. Employees can see payment history and download a payslip after confirmed settlement.

Payroll is not an automatic recurring debit. A business must have the source assets in its wallet and approve the outgoing deposits. NEAR-source payments may share one wallet approval when compatible; the individual provider settlements remain separate.

Payroll administration is shown only in a business/team workspace to its owners and admins. Freelancer workspaces and regular employee members do not see payroll administration. All active account types can receive invoices.

## What must feel connected in the app

- **One invoice record:** sender list, recipient dashboard, public checkout, payment history, and receipt all refer to the same invoice.
- **One payable list:** Bills to pay is derived from received invoices and prepared payroll. There is no separate bill-entry or invoice-import workflow.
- **Automatic settlement follow-through:** open provider quotes are refreshed in the background; confirmed, partial, failed, or refunded results update the invoice and notify the sender.
- **A useful “money received” next step:** explain that funds went to the invoice’s receiving wallet, show wallet balances, and point business users to Bills to pay or Payroll.
- **A guided pay run:** make the add people → prepare → approve → fund → confirm sequence visible, including the fact that approval alone does not pay staff.
- **Clear product boundaries:** testnet only today; Local Exchange and automatic recurring payroll are not available. A Veyra-owned smart contract is unnecessary for this invoice-to-wallet and wallet-approved payout model.

## Out of scope for this product direction

- Holding customer funds in a Veyra-controlled wallet or escrow contract.
- Uploading third-party invoice documents as the main invoice workflow.
- Sending invoices to people who do not have a Veyra account.
- Claiming that a quote, wallet approval, or submitted transaction is a completed payment before provider settlement is confirmed.
- Local currency exchange, unsupported networks, and mainnet payments in the current testnet build.
