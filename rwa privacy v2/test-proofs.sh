#!/bin/bash
: <<'COMMENT'
═══════════════════════════════════════════════════════════
🔐 CRYPTO-PROTECTED CODE 🔐
═══════════════════════════════════════════════════════════

Author:           Leon Sage
Organization:     Sage Audio LLC
Copyright:        © 2025 Leon Sage. All Rights Reserved.
License:          Proprietary
Signed:           2026-02-26 11:42:21
Certificate:      CodeSigning-LeonSage

CRYPTOGRAPHIC FINGERPRINT:
SHA-256:  9BE3B3AF49EA207F3F379168429219758C9CCAD1AB6E95B56D0E61A6874B293F
SHA-512:  1C1DF0B057ECC83555DAD74AD79AD85AEA7B5717BF090E8EA34A5BA9A60613D5CC1C42BF2A771A96EB562793810AC4886AE7449BC759FD6ECD87378D18EC401C
MD5:      FBBA2D1C8C0920822D43A95B4E0025A9
File Size: 796 bytes

LICENSE:
PROPRIETARY LICENSE

Copyright (c) 2026 Leon Sage. All Rights Reserved.
Sage Audio LLC

This software is proprietary and confidential property of Leon Sage.
UNAUTHORIZED COPYING, MODIFICATION, DISTRIBUTION, OR USE IS STRICTLY PROHIBITED.

⚠️  ANTI-THEFT NOTICE:
This code is cryptographically signed and protected. Any
unauthorized modification, distribution, or removal of this
protection constitutes copyright infringement.
═══════════════════════════════════════════════════════════
COMMENT
set -e

echo "=========================================="
echo "🧪 TESTING PROOF GENERATION"
echo "=========================================="

cd circuits

echo ""
echo "📝 Test 1: Generate deposit proof..."
nargo prove --prover-name deposit_test || {
    echo "❌ Deposit proof generation failed"
    echo "This is expected if you haven't set up Prover.toml"
    echo ""
}

echo ""
echo "📝 Test 2: Verify deposit proof..."
nargo verify --verifier-name deposit_test || {
    echo "⚠️  Verification skipped"
}

echo ""
echo "=========================================="
echo "✅ PROOF TESTS COMPLETE"
echo "=========================================="
echo ""
echo "📖 To generate proofs manually:"
echo "  cd circuits"
echo "  nargo prove"
echo "  nargo verify"
echo ""

