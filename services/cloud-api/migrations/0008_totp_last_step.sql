-- 0008_totp_last_step — single-use TOTP. Track the last accepted time-step per
-- account so a code captured + replayed within the ±1 window is rejected.
ALTER TABLE totp_secrets ADD COLUMN last_step INTEGER;
