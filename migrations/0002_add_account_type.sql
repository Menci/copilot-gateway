-- Add account_type column to github_accounts (was missing from initial migration)
ALTER TABLE github_accounts ADD COLUMN account_type TEXT NOT NULL DEFAULT 'individual';
