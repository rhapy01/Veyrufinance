ALTER TABLE trezu_payroll_items
  ADD COLUMN IF NOT EXISTS deposit_tx_hash text;

-- Recover source-chain transfers already reported by the provider. Keep these
-- items locked against another wallet send while settlement is in progress.
UPDATE trezu_payroll_items AS item
SET deposit_tx_hash = CASE
  WHEN jsonb_typeof(item_quote.provider_status_payload #> '{swapDetails,originChainTxHashes,0}') = 'object'
    THEN item_quote.provider_status_payload #>> '{swapDetails,originChainTxHashes,0,hash}'
  WHEN jsonb_typeof(item_quote.provider_status_payload #> '{swapDetails,originChainTxHashes,0}') = 'string'
    THEN item_quote.provider_status_payload #>> '{swapDetails,originChainTxHashes,0}'
  ELSE NULL
END
FROM trezu_near_intent_quotes AS item_quote
WHERE item.payment_quote_id = item_quote.id
  AND item.deposit_tx_hash IS NULL
  AND item.status IN ('processing', 'pending_settlement')
  AND jsonb_array_length(COALESCE(item_quote.provider_status_payload #> '{swapDetails,originChainTxHashes}', '[]'::jsonb)) > 0;
