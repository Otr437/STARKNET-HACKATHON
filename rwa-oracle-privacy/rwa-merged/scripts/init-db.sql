-- init-db.sql
-- Run once by PostgreSQL on first container start.
-- Creates the database user with a secure connection limit.

ALTER USER rwa_oracle CONNECTION LIMIT 50;
GRANT ALL PRIVILEGES ON DATABASE rwa_oracle TO rwa_oracle;
