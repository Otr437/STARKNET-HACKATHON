-- CreateEnum
CREATE TYPE "Role" AS ENUM ('SUPER_ADMIN', 'ADMIN', 'OPERATOR', 'VIEWER');
CREATE TYPE "SubmitStatus" AS ENUM ('PENDING', 'CONFIRMED', 'FAILED', 'SKIPPED');
CREATE TYPE "AlertType" AS ENUM ('PRICE_STALE', 'DEVIATION_HIGH', 'SUBMISSION_FAILED', 'SOURCE_DOWN');

-- CreateTable: User
CREATE TABLE "User" (
    "id"           TEXT NOT NULL,
    "email"        TEXT NOT NULL,
    "username"     TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role"         "Role" NOT NULL DEFAULT 'VIEWER',
    "active"       BOOLEAN NOT NULL DEFAULT true,
    "mfaSecret"    TEXT,
    "mfaEnabled"   BOOLEAN NOT NULL DEFAULT false,
    "lastLoginAt"  TIMESTAMP(3),
    "lastLoginIp"  TEXT,
    "failedLogins" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil"  TIMESTAMP(3),
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    TIMESTAMP(3) NOT NULL,
    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "User_email_key"    ON "User"("email");
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");
CREATE INDEX "User_email_idx"  ON "User"("email");
CREATE INDEX "User_active_idx" ON "User"("active");

-- CreateTable: Session
CREATE TABLE "Session" (
    "id"        TEXT NOT NULL,
    "userId"    TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "ipAddress" TEXT NOT NULL,
    "userAgent" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");
CREATE INDEX "Session_userId_idx"    ON "Session"("userId");
CREATE INDEX "Session_tokenHash_idx" ON "Session"("tokenHash");
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");
CREATE INDEX "Session_revokedAt_idx" ON "Session"("revokedAt");

-- CreateTable: ApiKey
CREATE TABLE "ApiKey" (
    "id"         TEXT NOT NULL,
    "name"       TEXT NOT NULL,
    "keyHash"    TEXT NOT NULL,
    "keyPrefix"  TEXT NOT NULL,
    "userId"     TEXT NOT NULL,
    "scopes"     TEXT[],
    "active"     BOOLEAN NOT NULL DEFAULT true,
    "lastUsedAt" TIMESTAMP(3),
    "lastUsedIp" TEXT,
    "expiresAt"  TIMESTAMP(3),
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt"  TIMESTAMP(3),
    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ApiKey_keyHash_key" ON "ApiKey"("keyHash");
CREATE INDEX "ApiKey_keyHash_idx" ON "ApiKey"("keyHash");
CREATE INDEX "ApiKey_userId_idx"  ON "ApiKey"("userId");
CREATE INDEX "ApiKey_active_idx"  ON "ApiKey"("active");

-- CreateTable: Asset
CREATE TABLE "Asset" (
    "id"            TEXT NOT NULL,
    "assetId"       TEXT NOT NULL,
    "symbol"        TEXT NOT NULL,
    "decimals"      INTEGER NOT NULL,
    "assetType"     TEXT NOT NULL,
    "active"        BOOLEAN NOT NULL DEFAULT true,
    "onChainTxHash" TEXT,
    "registeredAt"  TIMESTAMP(3),
    "description"   TEXT,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Asset_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Asset_assetId_key"   ON "Asset"("assetId");
CREATE INDEX "Asset_assetId_idx"   ON "Asset"("assetId");
CREATE INDEX "Asset_active_idx"    ON "Asset"("active");
CREATE INDEX "Asset_assetType_idx" ON "Asset"("assetType");

-- CreateTable: PriceFeed
CREATE TABLE "PriceFeed" (
    "id"        TEXT NOT NULL,
    "assetId"   TEXT NOT NULL,
    "source"    TEXT NOT NULL,
    "price"     DECIMAL(30,10) NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PriceFeed_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PriceFeed_assetId_source_timestamp_key" ON "PriceFeed"("assetId","source","timestamp");
CREATE INDEX "PriceFeed_assetId_source_idx" ON "PriceFeed"("assetId","source");
CREATE INDEX "PriceFeed_fetchedAt_idx"      ON "PriceFeed"("fetchedAt");
CREATE INDEX "PriceFeed_timestamp_idx"      ON "PriceFeed"("timestamp");

-- CreateTable: PriceHistory
CREATE TABLE "PriceHistory" (
    "id"           TEXT NOT NULL,
    "assetId"      TEXT NOT NULL,
    "medianPrice"  DECIMAL(30,10) NOT NULL,
    "sourceCount"  INTEGER NOT NULL,
    "sources"      TEXT[],
    "onChainPrice" BIGINT NOT NULL,
    "timestamp"    TIMESTAMP(3) NOT NULL,
    "txHash"       TEXT,
    "blockNumber"  BIGINT,
    "submittedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status"       "SubmitStatus" NOT NULL DEFAULT 'PENDING',
    "errorMessage" TEXT,
    CONSTRAINT "PriceHistory_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PriceHistory_assetId_idx"        ON "PriceHistory"("assetId");
CREATE INDEX "PriceHistory_assetId_status_idx" ON "PriceHistory"("assetId","status");
CREATE INDEX "PriceHistory_timestamp_idx"      ON "PriceHistory"("timestamp");
CREATE INDEX "PriceHistory_submittedAt_idx"    ON "PriceHistory"("submittedAt");
CREATE INDEX "PriceHistory_status_idx"         ON "PriceHistory"("status");
CREATE INDEX "PriceHistory_txHash_idx"         ON "PriceHistory"("txHash");

-- CreateTable: AuditLog
CREATE TABLE "AuditLog" (
    "id"        TEXT NOT NULL,
    "userId"    TEXT,
    "action"    TEXT NOT NULL,
    "resource"  TEXT,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "metadata"  JSONB,
    "success"   BOOLEAN NOT NULL,
    "errorMsg"  TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AuditLog_userId_idx"    ON "AuditLog"("userId");
CREATE INDEX "AuditLog_action_idx"    ON "AuditLog"("action");
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");
CREATE INDEX "AuditLog_success_idx"   ON "AuditLog"("success");

-- CreateTable: AlertRule
CREATE TABLE "AlertRule" (
    "id"              TEXT NOT NULL,
    "assetId"         TEXT NOT NULL,
    "type"            "AlertType" NOT NULL,
    "threshold"       DECIMAL(20,6) NOT NULL,
    "webhookUrl"      TEXT,
    "emailRecipients" TEXT[],
    "active"          BOOLEAN NOT NULL DEFAULT true,
    "lastTriggeredAt" TIMESTAMP(3),
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AlertRule_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AlertRule_assetId_idx"       ON "AlertRule"("assetId");
CREATE INDEX "AlertRule_type_active_idx"   ON "AlertRule"("type","active");
CREATE INDEX "AlertRule_active_idx"        ON "AlertRule"("active");

-- AddForeignKeys
ALTER TABLE "Session"      ADD CONSTRAINT "Session_userId_fkey"      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ApiKey"       ADD CONSTRAINT "ApiKey_userId_fkey"       FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PriceFeed"    ADD CONSTRAINT "PriceFeed_assetId_fkey"   FOREIGN KEY ("assetId") REFERENCES "Asset"("assetId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PriceHistory" ADD CONSTRAINT "PriceHistory_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("assetId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AuditLog"     ADD CONSTRAINT "AuditLog_userId_fkey"     FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AlertRule"    ADD CONSTRAINT "AlertRule_assetId_fkey"   FOREIGN KEY ("assetId") REFERENCES "Asset"("assetId") ON DELETE RESTRICT ON UPDATE CASCADE;
