/*
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
SHA-256:  59AB0BE9955BFD7EBD6296140217C5FF39F738D5B3A7536891BFC082AC0195F3
SHA-512:  C4C3F567F762C4C7B7B82D44E5F3928F2EAD127C56DD17F8BD70D545976FA915EB2216906DB896E74A67114DD35CD74C7E02B9E214D6F3BC763D199633776A7D
MD5:      30D8D9936E1514DA11D8C3B9967FC67B
File Size: 7832 bytes

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
*/
export const abi = [
  {
    "type": "impl",
    "name": "PriceOracleImpl",
    "interface_name": "IPriceOracle"
  },
  {
    "type": "struct",
    "name": "core::integer::u256",
    "members": [
      {
        "name": "low",
        "type": "core::integer::u128"
      },
      {
        "name": "high",
        "type": "core::integer::u128"
      }
    ]
  },
  {
    "type": "struct",
    "name": "PriceData",
    "members": [
      {
        "name": "price",
        "type": "core::integer::u256"
      },
      {
        "name": "decimals",
        "type": "core::integer::u8"
      },
      {
        "name": "timestamp",
        "type": "core::integer::u64"
      },
      {
        "name": "source_count",
        "type": "core::integer::u8"
      },
      {
        "name": "confidence",
        "type": "core::integer::u8"
      }
    ]
  },
  {
    "type": "interface",
    "name": "IPriceOracle",
    "items": [
      {
        "type": "function",
        "name": "update_price",
        "inputs": [
          {
            "name": "symbol",
            "type": "core::felt252"
          },
          {
            "name": "price",
            "type": "core::integer::u256"
          },
          {
            "name": "decimals",
            "type": "core::integer::u8"
          },
          {
            "name": "timestamp",
            "type": "core::integer::u64"
          }
        ],
        "outputs": [],
        "state_mutability": "external"
      },
      {
        "type": "function",
        "name": "update_prices",
        "inputs": [
          {
            "name": "symbols",
            "type": "core::array::Span::<core::felt252>"
          },
          {
            "name": "prices",
            "type": "core::array::Span::<core::integer::u256>"
          },
          {
            "name": "decimals_list",
            "type": "core::array::Span::<core::integer::u8>"
          },
          {
            "name": "timestamps",
            "type": "core::array::Span::<core::integer::u64>"
          }
        ],
        "outputs": [],
        "state_mutability": "external"
      },
      {
        "type": "function",
        "name": "get_price",
        "inputs": [
          {
            "name": "symbol",
            "type": "core::felt252"
          }
        ],
        "outputs": [
          {
            "type": "(core::integer::u256, core::integer::u8, core::integer::u64)"
          }
        ],
        "state_mutability": "view"
      },
      {
        "type": "function",
        "name": "get_price_data",
        "inputs": [
          {
            "name": "symbol",
            "type": "core::felt252"
          }
        ],
        "outputs": [
          {
            "type": "PriceData"
          }
        ],
        "state_mutability": "view"
      },
      {
        "type": "function",
        "name": "is_price_stale",
        "inputs": [
          {
            "name": "symbol",
            "type": "core::felt252"
          },
          {
            "name": "max_age",
            "type": "core::integer::u64"
          }
        ],
        "outputs": [
          {
            "type": "core::bool"
          }
        ],
        "state_mutability": "view"
      },
      {
        "type": "function",
        "name": "get_last_update_time",
        "inputs": [
          {
            "name": "symbol",
            "type": "core::felt252"
          }
        ],
        "outputs": [
          {
            "type": "core::integer::u64"
          }
        ],
        "state_mutability": "view"
      },
      {
        "type": "function",
        "name": "has_price",
        "inputs": [
          {
            "name": "symbol",
            "type": "core::felt252"
          }
        ],
        "outputs": [
          {
            "type": "core::bool"
          }
        ],
        "state_mutability": "view"
      },
      {
        "type": "function",
        "name": "set_oracle",
        "inputs": [
          {
            "name": "new_oracle",
            "type": "core::starknet::contract_address::ContractAddress"
          }
        ],
        "outputs": [],
        "state_mutability": "external"
      },
      {
        "type": "function",
        "name": "set_authorized",
        "inputs": [
          {
            "name": "account",
            "type": "core::starknet::contract_address::ContractAddress"
          },
          {
            "name": "authorized",
            "type": "core::bool"
          }
        ],
        "outputs": [],
        "state_mutability": "external"
      },
      {
        "type": "function",
        "name": "transfer_ownership",
        "inputs": [
          {
            "name": "new_owner",
            "type": "core::starknet::contract_address::ContractAddress"
          }
        ],
        "outputs": [],
        "state_mutability": "external"
      },
      {
        "type": "function",
        "name": "get_owner",
        "inputs": [],
        "outputs": [
          {
            "type": "core::starknet::contract_address::ContractAddress"
          }
        ],
        "state_mutability": "view"
      },
      {
        "type": "function",
        "name": "get_oracle",
        "inputs": [],
        "outputs": [
          {
            "type": "core::starknet::contract_address::ContractAddress"
          }
        ],
        "state_mutability": "view"
      },
      {
        "type": "function",
        "name": "is_address_authorized",
        "inputs": [
          {
            "name": "account",
            "type": "core::starknet::contract_address::ContractAddress"
          }
        ],
        "outputs": [
          {
            "type": "core::bool"
          }
        ],
        "state_mutability": "view"
      }
    ]
  },
  {
    "type": "constructor",
    "name": "constructor",
    "inputs": [
      {
        "name": "owner",
        "type": "core::starknet::contract_address::ContractAddress"
      },
      {
        "name": "oracle",
        "type": "core::starknet::contract_address::ContractAddress"
      }
    ]
  },
  {
    "type": "event",
    "name": "PriceUpdated",
    "kind": "struct",
    "members": [
      {
        "name": "symbol",
        "type": "core::felt252",
        "kind": "data"
      },
      {
        "name": "price",
        "type": "core::integer::u256",
        "kind": "data"
      },
      {
        "name": "decimals",
        "type": "core::integer::u8",
        "kind": "data"
      },
      {
        "name": "timestamp",
        "type": "core::integer::u64",
        "kind": "data"
      },
      {
        "name": "confidence",
        "type": "core::integer::u8",
        "kind": "data"
      }
    ]
  },
  {
    "type": "event",
    "name": "OracleChanged",
    "kind": "struct",
    "members": [
      {
        "name": "old_oracle",
        "type": "core::starknet::contract_address::ContractAddress",
        "kind": "data"
      },
      {
        "name": "new_oracle",
        "type": "core::starknet::contract_address::ContractAddress",
        "kind": "data"
      }
    ]
  },
  {
    "type": "event",
    "name": "AuthorizationChanged",
    "kind": "struct",
    "members": [
      {
        "name": "account",
        "type": "core::starknet::contract_address::ContractAddress",
        "kind": "data"
      },
      {
        "name": "authorized",
        "type": "core::bool",
        "kind": "data"
      }
    ]
  },
  {
    "type": "event",
    "name": "OwnershipTransferred",
    "kind": "struct",
    "members": [
      {
        "name": "previous_owner",
        "type": "core::starknet::contract_address::ContractAddress",
        "kind": "data"
      },
      {
        "name": "new_owner",
        "type": "core::starknet::contract_address::ContractAddress",
        "kind": "data"
      }
    ]
  }
];

