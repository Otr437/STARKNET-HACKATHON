// prisma/seed.ts
// ─────────────────────────────────────────────────────────────
//  Database seed
//  Run with: npm run db:seed
//
//  Creates:
//    1. A SUPER_ADMIN user (credentials from env or defaults)
//    2. All 15 RWA assets matching the feeder's ASSETS config
// ─────────────────────────────────────────────────────────────

import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

const SEED_EMAIL    = process.env.SEED_ADMIN_EMAIL    ?? "admin@rwa-oracle.local";
const SEED_USERNAME = process.env.SEED_ADMIN_USERNAME ?? "superadmin";
const SEED_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? "ChangeMe!2025#";

const ASSETS = [
  { assetId: "XAU_USD",    symbol: "XAU",    decimals: 8, assetType: "COMMODITY", description: "Gold spot price (USD per troy oz)" },
  { assetId: "XAG_USD",    symbol: "XAG",    decimals: 8, assetType: "COMMODITY", description: "Silver spot price (USD per troy oz)" },
  { assetId: "XPT_USD",    symbol: "XPT",    decimals: 8, assetType: "COMMODITY", description: "Platinum spot price (USD per troy oz)" },
  { assetId: "XPD_USD",    symbol: "XPD",    decimals: 8, assetType: "COMMODITY", description: "Palladium spot price (USD per troy oz)" },
  { assetId: "WTI_USD",    symbol: "WTI",    decimals: 8, assetType: "COMMODITY", description: "WTI Crude Oil (USD per barrel)" },
  { assetId: "BRENT_USD",  symbol: "BRENT",  decimals: 8, assetType: "COMMODITY", description: "Brent Crude Oil (USD per barrel)" },
  { assetId: "NATGAS_USD", symbol: "NATGAS", decimals: 8, assetType: "COMMODITY", description: "Natural Gas (USD per MMBtu)" },
  { assetId: "COPPER_USD", symbol: "COPPER", decimals: 8, assetType: "COMMODITY", description: "Copper (USD per troy oz)" },
  { assetId: "ALUM_USD",   symbol: "ALUM",   decimals: 8, assetType: "COMMODITY", description: "Aluminum (USD per metric ton)" },
  { assetId: "WHEAT_USD",  symbol: "WHEAT",  decimals: 8, assetType: "COMMODITY", description: "Wheat (USD per bushel)" },
  { assetId: "CORN_USD",   symbol: "CORN",   decimals: 8, assetType: "COMMODITY", description: "Corn (USD per bushel)" },
  { assetId: "US_CPI",     symbol: "CPI",    decimals: 4, assetType: "MACRO",     description: "US Consumer Price Index (monthly)" },
  { assetId: "US_INFL",    symbol: "INFL",   decimals: 4, assetType: "MACRO",     description: "US Inflation Rate % (annual, monthly)" },
  { assetId: "FED_RATE",   symbol: "FFR",    decimals: 4, assetType: "MACRO",     description: "US Federal Funds Rate %" },
  { assetId: "US_10YR",    symbol: "10YR",   decimals: 4, assetType: "MACRO",     description: "US 10-Year Treasury Yield %" },
];

async function main() {
  console.log("🌱 Seeding database...\n");

  // ── Create SUPER_ADMIN ────────────────────────────────────
  const existingAdmin = await prisma.user.findUnique({ where: { email: SEED_EMAIL } });

  if (existingAdmin) {
    console.log(`✓ Super admin already exists: ${SEED_EMAIL}`);
  } else {
    const passwordHash = await bcrypt.hash(SEED_PASSWORD, 12);
    const admin = await prisma.user.create({
      data: {
        email:        SEED_EMAIL,
        username:     SEED_USERNAME,
        passwordHash,
        role:         "SUPER_ADMIN",
        active:       true,
      },
    });
    console.log(`✓ Created SUPER_ADMIN: ${admin.email} (id: ${admin.id})`);
    console.log(`  ⚠️  Default password: ${SEED_PASSWORD}`);
    console.log(`  ⚠️  CHANGE THIS IMMEDIATELY after first login!\n`);
  }

  // ── Seed Assets ───────────────────────────────────────────
  console.log("Registering assets...");
  for (const asset of ASSETS) {
    const existing = await prisma.asset.findUnique({ where: { assetId: asset.assetId } });
    if (existing) {
      console.log(`  ✓ ${asset.assetId} already exists — skipping`);
      continue;
    }
    await prisma.asset.create({ data: asset });
    console.log(`  + ${asset.assetId} (${asset.symbol}) — ${asset.assetType}`);
  }

  console.log("\n✅ Seed complete.");
  console.log("Run `npm run db:studio` to browse the database visually.");
}

main()
  .catch((e) => {
    console.error("Seed failed:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
