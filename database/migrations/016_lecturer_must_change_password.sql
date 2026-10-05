-- 016_lecturer_must_change_password.sql
-- Migration 016: forced first-login password change for admin-created lecturer accounts.
--   * adds `users.must_change_password`
--   * the default is false, so every existing account (admin, student, lecturer) is
--     unaffected: nothing already signed in is forced to change anything
--   * only an account created through the admin lecturer endpoint sets it to true,
--     which is what makes the temporary password a one-time credential
--
-- Additive and non-destructive: no column is dropped or rewritten.

ALTER TABLE users
  ADD COLUMN must_change_password BOOLEAN NOT NULL DEFAULT false;
