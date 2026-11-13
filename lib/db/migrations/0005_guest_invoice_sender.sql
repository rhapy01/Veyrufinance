ALTER TABLE trezu_invoices
  ADD COLUMN IF NOT EXISTS sender_email text;
