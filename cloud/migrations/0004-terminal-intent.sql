-- v2 requests require proof from the browser-local terminal before approval.
ALTER TABLE login_requests ADD COLUMN intent_challenge TEXT;
ALTER TABLE login_requests ADD COLUMN expected_workspace TEXT;
