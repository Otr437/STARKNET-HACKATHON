# API Documentation

Complete API reference for all three Starknet services.

---

## 🏦 Vault Manager API

Base URL: `http://localhost:3001`

### Health Check
```http
GET /health
```

**Response:**
```json
{
  "status": "ok",
  "service": "vault-manager-api"
}
```

### Get Total TVL
```http
GET /api/vault/tvl
```

**Response:**
```json
{
  "success": true,
  "tvl": "1000000000000000000000"
}
```

### Get User Balance
```http
GET /api/vault/balance/:userAddress/:assetAddress
```

**Parameters:**
- `userAddress` - Starknet address of user
- `assetAddress` - Asset contract address

**Response:**
```json
{
  "success": true,
  "user": "0x123...",
  "asset": "0x456...",
  "balance": "500000000000000000000"
}
```

### Check Curator Status
```http
GET /api/vault/curator/:address
```

**Response:**
```json
{
  "success": true,
  "address": "0x123...",
  "is_curator": true
}
```

### Prepare Deposit
```http
POST /api/vault/prepare-deposit
Content-Type: application/json

{
  "assetAddress": "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7",
  "amount": "1000000000000000000"
}
```

**Response:**
```json
{
  "success": true,
  "callData": {
    "contractAddress": "0x...",
    "entrypoint": "deposit",
    "calldata": ["0x...", "1000000000000000000", "0"]
  },
  "message": "Send this transaction using your Starknet wallet"
}
```

### Prepare Withdraw
```http
POST /api/vault/prepare-withdraw
Content-Type: application/json

{
  "assetAddress": "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7",
  "amount": "500000000000000000"
}
```

### Get Analytics
```http
GET /api/vault/analytics
```

**Response:**
```json
{
  "success": true,
  "analytics": {
    "total_tvl": "1000000000000000000000",
    "total_users": 150,
    "total_deposits": 500,
    "total_withdrawals": 120,
    "curator_count": 3
  }
}
```

---

## ₿ BTC Swap API

Base URL: `http://localhost:3002`

### Health Check
```http
GET /health
```

### Initiate Swap
```http
POST /api/swap/initiate
Content-Type: application/json

{
  "participantAddress": "0x123...",
  "assetAddress": "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7",
  "amount": "1000000000000000000",
  "btcAddress": "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx",
  "btcAmount": "10000000",
  "timeLockHours": 24
}
```

**Response:**
```json
{
  "success": true,
  "swapId": "1704985200123",
  "hashLock": "0xa3b4c5d6e7f8...",
  "timeLock": 1704985200,
  "btcAddress": "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx",
  "callData": {
    "contractAddress": "0x...",
    "entrypoint": "initiate_swap",
    "calldata": [...]
  },
  "message": "Submit this transaction to initiate the swap. Secret will be revealed upon completion."
}
```

### Get Swap Details
```http
GET /api/swap/:swapId
```

**Response:**
```json
{
  "success": true,
  "swap": {
    "swapId": "1704985200123",
    "participantAddress": "0x123...",
    "assetAddress": "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7",
    "amount": "1000000000000000000",
    "hashLock": "0xa3b4c5d6e7f8...",
    "timeLock": 1704985200,
    "btcAddress": "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx",
    "btcAmount": "10000000",
    "status": "initiated"
  }
}
```

### Complete Swap
```http
POST /api/swap/complete
Content-Type: application/json

{
  "swapId": "1704985200123",
  "btcTxHash": "abc123def456..."
}
```

**Response:**
```json
{
  "success": true,
  "secret": "deadbeef...",
  "message": "Use this secret to complete the swap on Starknet",
  "callData": {
    "contractAddress": "0x...",
    "entrypoint": "complete_swap",
    "calldata": ["1704985200123", "0xdeadbeef..."]
  }
}
```

### Create Bitcoin HTLC Script
```http
POST /api/swap/btc-script
Content-Type: application/json

{
  "hashLock": "a3b4c5d6e7f8...",
  "recipientPubKey": "02abc123...",
  "senderPubKey": "03def456...",
  "timeLock": 1704985200
}
```

**Response:**
```json
{
  "success": true,
  "htlcAddress": "2N8hwP1WmJrFF5QWABn38y63uYLhnJYJYTF",
  "script": "63a820a3b4c5d6e7f8...",
  "message": "Send BTC to this address to lock funds"
}
```

### Get User Swaps
```http
GET /api/swap/user/:address
```

**Response:**
```json
{
  "success": true,
  "swaps": [
    {
      "swapId": "1704985200123",
      "participantAddress": "0x123...",
      "status": "completed",
      "amount": "1000000000000000000"
    }
  ]
}
```

### Verify Secret
```http
POST /api/swap/verify-secret
Content-Type: application/json

{
  "secret": "deadbeef...",
  "hashLock": "0xa3b4c5d6e7f8..."
}
```

**Response:**
```json
{
  "success": true,
  "isValid": true,
  "computedHash": "0xa3b4c5d6e7f8..."
}
```

---

## 🔐 Semaphore API

Base URL: `http://localhost:3003`

### Health Check
```http
GET /health
```

### Generate Identity
```http
POST /api/identity/generate
```

**Response:**
```json
{
  "success": true,
  "identityId": "550e8400-e29b-41d4-a716-446655440000",
  "commitment": "0x12ab34cd56ef...",
  "message": "Store your identityId securely. You will need it to prove membership."
}
```

### Create Group
```http
POST /api/group/create
Content-Type: application/json

{
  "adminAddress": "0x123...",
  "groupName": "DAO Voters",
  "description": "Anonymous voting group for proposals"
}
```

**Response:**
```json
{
  "success": true,
  "groupId": "1704985200123",
  "callData": {
    "contractAddress": "0x...",
    "entrypoint": "create_group",
    "calldata": ["0x123..."]
  },
  "message": "Submit this transaction to create the group on-chain"
}
```

### Add Member to Group
```http
POST /api/group/add-member
Content-Type: application/json

{
  "groupId": "1704985200123",
  "identityId": "550e8400-e29b-41d4-a716-446655440000"
}
```

**Response:**
```json
{
  "success": true,
  "commitment": "0x12ab34cd56ef...",
  "callData": {
    "contractAddress": "0x...",
    "entrypoint": "add_member",
    "calldata": ["1704985200123", "0x12ab34cd56ef..."]
  },
  "message": "Submit this transaction to add member to group"
}
```

### Generate Proof
```http
POST /api/proof/generate
Content-Type: application/json

{
  "identityId": "550e8400-e29b-41d4-a716-446655440000",
  "groupId": "1704985200123",
  "signal": "I vote YES on proposal #42",
  "externalNullifier": "proposal-42"
}
```

**Response:**
```json
{
  "success": true,
  "proof": {
    "groupId": "1704985200123",
    "signal": "I vote YES on proposal #42",
    "nullifierHash": "0xabcd1234...",
    "externalNullifier": "proposal-42",
    "proofData": ["0x1", "0x2", "0x3"]
  },
  "callData": {
    "contractAddress": "0x...",
    "entrypoint": "verify_proof",
    "calldata": [...]
  },
  "message": "Submit this proof to send anonymous signal"
}
```

### Get Group Info
```http
GET /api/group/:groupId
```

**Response:**
```json
{
  "success": true,
  "group": {
    "groupId": "1704985200123",
    "size": "25",
    "merkleRoot": "0x789abc...",
    "name": "DAO Voters",
    "description": "Anonymous voting group for proposals",
    "admin": "0x123...",
    "members": [...]
  }
}
```

### Check Nullifier Status
```http
GET /api/nullifier/:nullifierHash
```

**Response:**
```json
{
  "success": true,
  "nullifierHash": "0xabcd1234...",
  "isUsed": false
}
```

### List All Groups
```http
GET /api/groups
```

**Response:**
```json
{
  "success": true,
  "groups": [
    {
      "groupId": "1704985200123",
      "name": "DAO Voters",
      "admin": "0x123...",
      "members": []
    }
  ]
}
```

### Validate Proof
```http
POST /api/proof/validate
Content-Type: application/json

{
  "proof": {
    "groupId": "1704985200123",
    "signal": "I vote YES",
    "nullifierHash": "0xabcd1234...",
    "proofData": ["0x1", "0x2", "0x3"]
  }
}
```

**Response:**
```json
{
  "success": true,
  "isValid": true,
  "message": "Proof structure is valid"
}
```

---

## Error Responses

All APIs follow a consistent error format:

```json
{
  "success": false,
  "error": "Error message describing what went wrong"
}
```

Common HTTP status codes:
- `200` - Success
- `400` - Bad Request (missing parameters, invalid input)
- `404` - Not Found (resource doesn't exist)
- `500` - Internal Server Error

---

## Rate Limiting

In production, implement rate limiting:
- Vault Manager: 100 requests/minute per IP
- BTC Swap: 50 requests/minute per IP
- Semaphore: 100 requests/minute per IP

---

## Authentication

For production deployments, implement authentication:
- API keys for server-to-server communication
- JWT tokens for user authentication
- Signature verification for transaction preparation

---

## WebSocket Support (Future)

Real-time updates for:
- Vault rebalancing events
- Swap status changes
- New group members
- Verified proofs

Example connection:
```javascript
const ws = new WebSocket('ws://localhost:3001/ws');
ws.on('message', (data) => {
  console.log('Event:', JSON.parse(data));
});
```
