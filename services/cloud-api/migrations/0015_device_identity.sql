-- 0015_device_identity — real device identity on sessions (replaces the generic
-- "node" user-agent in the devices list). device_name = os.hostname(), os_release
-- = os.release() (sent by the desktop as x-cs-device-name / x-cs-os-release);
-- geo_country/geo_city come from Cloudflare's request.cf (coarse, free). The IP
-- itself stays HASHED (ip_hash) — never stored in clear. All nullable, existing
-- rows backfill NULL. Forward-only.
ALTER TABLE sessions ADD COLUMN device_name TEXT;
ALTER TABLE sessions ADD COLUMN os_release TEXT;
ALTER TABLE sessions ADD COLUMN geo_country TEXT;
ALTER TABLE sessions ADD COLUMN geo_city TEXT;
