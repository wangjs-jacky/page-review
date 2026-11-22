ALTER TABLE cli_connections ADD COLUMN read_protocol INTEGER NOT NULL DEFAULT 0 CHECK(read_protocol IN (0,1));
ALTER TABLE cli_connections ADD COLUMN client_version TEXT;
