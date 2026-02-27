// ============================================================
//  InflationOracle.cairo
//  Starknet RWA Factory — Macro-Economic Data Oracle
//
//  Architecture: Permissioned publisher model (Pragma-inspired)
//  Multiple whitelisted publishers push signed off-chain data.
//  Contract stores latest values per publisher and exposes
//  a median-aggregated view.
//
//  Data sourced off-chain from:
//    - US BLS API  : CPI-U (CUUR0000SA0)
//    - FRED API    : TB3MS (3M T-Bill), DGS10 (10Y), FEDFUNDS
//
//  All rates stored as basis points (100 bps = 1%)
//  CPI stored as fixed-point 1e2 (e.g. 314.12 → 31412)
// ============================================================

#[starknet::contract]
mod InflationOracle {
    use starknet::{
        ContractAddress, get_caller_address, get_block_timestamp,
        storage::{Map, StorageMapReadAccess, StorageMapWriteAccess},
    };
    use core::array::ArrayTrait;
    use core::traits::Into;

    use super::super::interfaces::{MacroDataPoint, IInflationOracle};

    // -------------------------------------------------------
    //  Constants
    // -------------------------------------------------------
    const ORACLE_DECIMALS: u128 = 100;           // CPI stored as 1e2
    const RATE_DECIMALS: u128  = 10000;          // rates in basis points
    const MAX_PUBLISHERS: u32  = 20;
    const DEFAULT_STALENESS: u64 = 172800;       // 48 hours in seconds
    const MIN_PUBLISHERS_FOR_MEDIAN: u32 = 1;   // single publisher ok for MVP

    // -------------------------------------------------------
    //  Storage
    // -------------------------------------------------------
    #[storage]
    struct Storage {
        // Admin
        admin: ContractAddress,
        pending_admin: ContractAddress,

        // Publisher registry
        publisher_count: u32,
        publishers: Map<u32, ContractAddress>,        // index → address
        publisher_index: Map<ContractAddress, u32>,   // address → index (0 = not registered)
        is_publisher: Map<ContractAddress, bool>,

        // Latest aggregated oracle data (median of all publishers)
        latest_cpi: u128,                // fixed-point 1e2
        latest_cpi_yoy_bps: u128,        // year-over-year rate in bps
        latest_tbill_3m_bps: u128,
        latest_tbill_10y_bps: u128,
        latest_fed_funds_bps: u128,
        latest_timestamp: u64,           // timestamp of the source data
        latest_update_block: u64,        // block timestamp when stored
        current_round_id: u64,

        // Per-publisher latest submissions (for median calculation)
        pub_cpi: Map<ContractAddress, u128>,
        pub_cpi_yoy_bps: Map<ContractAddress, u128>,
        pub_tbill_3m_bps: Map<ContractAddress, u128>,
        pub_tbill_10y_bps: Map<ContractAddress, u128>,
        pub_fed_funds_bps: Map<ContractAddress, u128>,
        pub_timestamp: Map<ContractAddress, u64>,
        pub_round: Map<ContractAddress, u64>,

        // Historical CPI rounds for inflation-adjustment math
        // round_id → CPI value
        cpi_history: Map<u64, u128>,
        cpi_base: u128,          // baseline CPI at oracle deployment

        // Config
        staleness_threshold: u64,
        is_paused: bool,
    }

    // -------------------------------------------------------
    //  Events
    // -------------------------------------------------------
    #[event]
    #[derive(Drop, starknet::Event)]
    enum Event {
        DataPublished: DataPublished,
        PublisherAdded: PublisherAdded,
        PublisherRemoved: PublisherRemoved,
        AdminTransferInitiated: AdminTransferInitiated,
        AdminTransferAccepted: AdminTransferAccepted,
        OraclePaused: OraclePaused,
        OracleUnpaused: OracleUnpaused,
    }

    #[derive(Drop, starknet::Event)]
    struct DataPublished {
        #[key]
        publisher: ContractAddress,
        #[key]
        round_id: u64,
        cpi_value: u128,
        cpi_yoy_bps: u128,
        tbill_3m_bps: u128,
        tbill_10y_bps: u128,
        fed_funds_bps: u128,
        data_timestamp: u64,
    }

    #[derive(Drop, starknet::Event)]
    struct PublisherAdded {
        #[key]
        publisher: ContractAddress,
        added_by: ContractAddress,
    }

    #[derive(Drop, starknet::Event)]
    struct PublisherRemoved {
        #[key]
        publisher: ContractAddress,
        removed_by: ContractAddress,
    }

    #[derive(Drop, starknet::Event)]
    struct AdminTransferInitiated {
        current_admin: ContractAddress,
        pending_admin: ContractAddress,
    }

    #[derive(Drop, starknet::Event)]
    struct AdminTransferAccepted {
        new_admin: ContractAddress,
    }

    #[derive(Drop, starknet::Event)]
    struct OraclePaused { by: ContractAddress }

    #[derive(Drop, starknet::Event)]
    struct OracleUnpaused { by: ContractAddress }

    // -------------------------------------------------------
    //  Constructor
    // -------------------------------------------------------
    #[constructor]
    fn constructor(
        ref self: ContractState,
        admin: ContractAddress,
        initial_publisher: ContractAddress,
        initial_cpi: u128,          // current CPI index * 100 (e.g. 31412 for 314.12)
        initial_tbill_3m_bps: u128, // e.g. 530 = 5.30%
        initial_tbill_10y_bps: u128,
        initial_fed_funds_bps: u128,
        initial_cpi_yoy_bps: u128,  // e.g. 270 = 2.70%
    ) {
        self.admin.write(admin);
        self.staleness_threshold.write(DEFAULT_STALENESS);
        self.is_paused.write(false);
        self.current_round_id.write(0);
        self.publisher_count.write(0);

        // Store initial values as round 0
        let now = get_block_timestamp();
        self.latest_cpi.write(initial_cpi);
        self.latest_cpi_yoy_bps.write(initial_cpi_yoy_bps);
        self.latest_tbill_3m_bps.write(initial_tbill_3m_bps);
        self.latest_tbill_10y_bps.write(initial_tbill_10y_bps);
        self.latest_fed_funds_bps.write(initial_fed_funds_bps);
        self.latest_timestamp.write(now);
        self.latest_update_block.write(now);
        self.cpi_base.write(initial_cpi);
        self.cpi_history.write(0, initial_cpi);

        // Register initial publisher
        self._register_publisher(initial_publisher);

        emit!(
            self.emit,
            PublisherAdded { publisher: initial_publisher, added_by: admin }
        );
    }

    // -------------------------------------------------------
    //  Implementation
    // -------------------------------------------------------
    #[abi(embed_v0)]
    impl InflationOracleImpl of IInflationOracle<ContractState> {

        // ---- Read: Current data ----

        fn get_cpi(self: @ContractState) -> MacroDataPoint {
            MacroDataPoint {
                value: self.latest_cpi.read(),
                timestamp: self.latest_timestamp.read(),
                publisher: self.admin.read(), // aggregated, use admin as sentinel
                round_id: self.current_round_id.read(),
            }
        }

        fn get_cpi_yoy_bps(self: @ContractState) -> u128 {
            self.latest_cpi_yoy_bps.read()
        }

        fn get_tbill_3m_rate_bps(self: @ContractState) -> MacroDataPoint {
            MacroDataPoint {
                value: self.latest_tbill_3m_bps.read(),
                timestamp: self.latest_timestamp.read(),
                publisher: self.admin.read(),
                round_id: self.current_round_id.read(),
            }
        }

        fn get_tbill_10y_rate_bps(self: @ContractState) -> MacroDataPoint {
            MacroDataPoint {
                value: self.latest_tbill_10y_bps.read(),
                timestamp: self.latest_timestamp.read(),
                publisher: self.admin.read(),
                round_id: self.current_round_id.read(),
            }
        }

        fn get_fed_funds_rate_bps(self: @ContractState) -> MacroDataPoint {
            MacroDataPoint {
                value: self.latest_fed_funds_bps.read(),
                timestamp: self.latest_timestamp.read(),
                publisher: self.admin.read(),
                round_id: self.current_round_id.read(),
            }
        }

        fn get_latest_round_id(self: @ContractState) -> u64 {
            self.current_round_id.read()
        }

        fn is_data_fresh(self: @ContractState) -> bool {
            if self.is_paused.read() {
                return false;
            }
            let now = get_block_timestamp();
            let last_update = self.latest_update_block.read();
            let threshold = self.staleness_threshold.read();
            (now - last_update) <= threshold
        }

        fn get_staleness_threshold(self: @ContractState) -> u64 {
            self.staleness_threshold.read()
        }

        fn get_publisher_count(self: @ContractState) -> u32 {
            self.publisher_count.read()
        }

        fn is_publisher(self: @ContractState, address: ContractAddress) -> bool {
            self.is_publisher.read(address)
        }

        fn get_oracle_admin(self: @ContractState) -> ContractAddress {
            self.admin.read()
        }

        // ---- Historical ----

        fn get_cpi_at_round(self: @ContractState, round_id: u64) -> MacroDataPoint {
            let cpi = self.cpi_history.read(round_id);
            // timestamp approximate — round_id is sequential, exact time not stored per round
            MacroDataPoint {
                value: cpi,
                timestamp: 0, // historical exact time not stored for gas efficiency
                publisher: self.admin.read(),
                round_id,
            }
        }

        fn get_cpi_index_base(self: @ContractState) -> u128 {
            self.cpi_base.read()
        }

        // ---- Publisher: publish_data ----
        // Called by off-chain TypeScript oracle publisher after fetching BLS+FRED APIs
        // Signature over: hash(cpi_value, tbill_3m, tbill_10y, fed_funds, data_timestamp, round_id)
        // For MVP: signature checked as non-zero (full ECDSA validation in production)

        fn publish_data(
            ref self: ContractState,
            cpi_value: u128,
            cpi_yoy_bps: u128,
            tbill_3m_bps: u128,
            tbill_10y_bps: u128,
            fed_funds_bps: u128,
            data_timestamp: u64,
            signature_r: felt252,
            signature_s: felt252,
        ) {
            assert!(!self.is_paused.read(), "Oracle: paused");
            let caller = get_caller_address();
            assert!(self.is_publisher.read(caller), "Oracle: not a publisher");

            // Validate signature fields are non-zero (publisher identity proof)
            assert!(signature_r != 0 && signature_s != 0, "Oracle: invalid signature");

            // Sanity bounds on data
            // CPI: must be between 1.00 and 999.99 (100 to 99999 in 1e2)
            assert!(cpi_value >= 100 && cpi_value <= 99999, "Oracle: CPI out of range");
            // Rates: 0 to 50% (0 to 5000 bps)
            assert!(tbill_3m_bps <= 5000, "Oracle: 3M T-Bill rate out of range");
            assert!(tbill_10y_bps <= 5000, "Oracle: 10Y rate out of range");
            assert!(fed_funds_bps <= 5000, "Oracle: Fed Funds rate out of range");
            // YoY CPI: -2000 bps (-20%) to +3000 bps (+30%)
            // Using u128 so negative not possible — floor at 0
            assert!(cpi_yoy_bps <= 3000, "Oracle: CPI YoY out of range");

            // Ensure data_timestamp is not from the far future
            let now = get_block_timestamp();
            assert!(data_timestamp <= now + 3600, "Oracle: future timestamp");
            assert!(data_timestamp >= now - 2592000, "Oracle: data too old (>30 days)"); // 30 days

            // Store per-publisher
            self.pub_cpi.write(caller, cpi_value);
            self.pub_cpi_yoy_bps.write(caller, cpi_yoy_bps);
            self.pub_tbill_3m_bps.write(caller, tbill_3m_bps);
            self.pub_tbill_10y_bps.write(caller, tbill_10y_bps);
            self.pub_fed_funds_bps.write(caller, fed_funds_bps);
            self.pub_timestamp.write(caller, data_timestamp);

            // Aggregate: with single publisher just use directly; with multi use median logic
            let pub_count = self.publisher_count.read();
            if pub_count == 1 {
                // Single publisher — direct update
                self._commit_aggregated(
                    cpi_value, cpi_yoy_bps, tbill_3m_bps,
                    tbill_10y_bps, fed_funds_bps, data_timestamp
                );
            } else {
                // Multi-publisher: collect all active publisher values and find median
                // In this version we use simple last-write aggregation with median of 3
                // Full implementation would collect array and sort
                let aggregated_cpi = self._aggregate_median_cpi();
                let aggregated_3m = self._aggregate_median_3m();
                let aggregated_10y = self._aggregate_median_10y();
                let aggregated_ff = self._aggregate_median_ff();
                let aggregated_yoy = self._aggregate_median_yoy();

                self._commit_aggregated(
                    aggregated_cpi, aggregated_yoy, aggregated_3m,
                    aggregated_10y, aggregated_ff, data_timestamp
                );
            }

            let round_id = self.current_round_id.read();
            self.emit(DataPublished {
                publisher: caller,
                round_id,
                cpi_value,
                cpi_yoy_bps,
                tbill_3m_bps,
                tbill_10y_bps,
                fed_funds_bps,
                data_timestamp,
            });
        }

        // ---- Admin functions ----

        fn add_publisher(ref self: ContractState, publisher: ContractAddress) {
            self._only_admin();
            assert!(!self.is_publisher.read(publisher), "Oracle: already a publisher");
            let count = self.publisher_count.read();
            assert!(count < MAX_PUBLISHERS, "Oracle: max publishers reached");
            self._register_publisher(publisher);
            self.emit(PublisherAdded {
                publisher,
                added_by: get_caller_address(),
            });
        }

        fn remove_publisher(ref self: ContractState, publisher: ContractAddress) {
            self._only_admin();
            assert!(self.is_publisher.read(publisher), "Oracle: not a publisher");
            self.is_publisher.write(publisher, false);
            let count = self.publisher_count.read();
            self.publisher_count.write(count - 1);
            self.emit(PublisherRemoved {
                publisher,
                removed_by: get_caller_address(),
            });
        }

        fn set_staleness_threshold(ref self: ContractState, seconds: u64) {
            self._only_admin();
            assert!(seconds >= 3600, "Oracle: threshold too low (<1hr)");
            assert!(seconds <= 604800, "Oracle: threshold too high (>7d)");
            self.staleness_threshold.write(seconds);
        }

        fn transfer_admin(ref self: ContractState, new_admin: ContractAddress) {
            self._only_admin();
            self.pending_admin.write(new_admin);
            self.emit(AdminTransferInitiated {
                current_admin: get_caller_address(),
                pending_admin: new_admin,
            });
        }
    }

    // -------------------------------------------------------
    //  Additional admin entrypoints (not in interface)
    // -------------------------------------------------------
    #[generate_trait]
    impl InternalImpl of InternalTrait {
        fn _only_admin(self: @ContractState) {
            assert!(get_caller_address() == self.admin.read(), "Oracle: not admin");
        }

        fn _register_publisher(ref self: ContractState, publisher: ContractAddress) {
            let count = self.publisher_count.read();
            self.publishers.write(count + 1, publisher);
            self.publisher_index.write(publisher, count + 1);
            self.is_publisher.write(publisher, true);
            self.publisher_count.write(count + 1);
        }

        fn _commit_aggregated(
            ref self: ContractState,
            cpi: u128, cpi_yoy: u128, tbill_3m: u128,
            tbill_10y: u128, fed_funds: u128, data_ts: u64
        ) {
            let new_round = self.current_round_id.read() + 1;
            self.current_round_id.write(new_round);

            self.latest_cpi.write(cpi);
            self.latest_cpi_yoy_bps.write(cpi_yoy);
            self.latest_tbill_3m_bps.write(tbill_3m);
            self.latest_tbill_10y_bps.write(tbill_10y);
            self.latest_fed_funds_bps.write(fed_funds);
            self.latest_timestamp.write(data_ts);
            self.latest_update_block.write(get_block_timestamp());

            // Store CPI in history for inflation adjustment calculations
            self.cpi_history.write(new_round, cpi);
        }

        // Median aggregation across registered publishers
        // For 1 publisher: returns that publisher's value
        // For 2: returns average
        // For 3+: returns true median (middle value after sorting)
        // This implementation handles up to 3 publishers efficiently;
        // for more publishers the off-chain aggregation node should pre-aggregate
        fn _aggregate_median_cpi(self: @ContractState) -> u128 {
            let count = self.publisher_count.read();
            if count == 0 { return self.latest_cpi.read(); }

            let p1 = self.publishers.read(1);
            if count == 1 { return self.pub_cpi.read(p1); }

            let p2 = self.publishers.read(2);
            let v1 = self.pub_cpi.read(p1);
            let v2 = self.pub_cpi.read(p2);
            if count == 2 { return (v1 + v2) / 2; }

            let p3 = self.publishers.read(3);
            let v3 = self.pub_cpi.read(p3);
            _median_of_three(v1, v2, v3)
        }

        fn _aggregate_median_3m(self: @ContractState) -> u128 {
            let count = self.publisher_count.read();
            if count == 0 { return self.latest_tbill_3m_bps.read(); }
            let p1 = self.publishers.read(1);
            if count == 1 { return self.pub_tbill_3m_bps.read(p1); }
            let p2 = self.publishers.read(2);
            let v1 = self.pub_tbill_3m_bps.read(p1);
            let v2 = self.pub_tbill_3m_bps.read(p2);
            if count == 2 { return (v1 + v2) / 2; }
            let p3 = self.publishers.read(3);
            let v3 = self.pub_tbill_3m_bps.read(p3);
            _median_of_three(v1, v2, v3)
        }

        fn _aggregate_median_10y(self: @ContractState) -> u128 {
            let count = self.publisher_count.read();
            if count == 0 { return self.latest_tbill_10y_bps.read(); }
            let p1 = self.publishers.read(1);
            if count == 1 { return self.pub_tbill_10y_bps.read(p1); }
            let p2 = self.publishers.read(2);
            let v1 = self.pub_tbill_10y_bps.read(p1);
            let v2 = self.pub_tbill_10y_bps.read(p2);
            if count == 2 { return (v1 + v2) / 2; }
            let p3 = self.publishers.read(3);
            let v3 = self.pub_tbill_10y_bps.read(p3);
            _median_of_three(v1, v2, v3)
        }

        fn _aggregate_median_ff(self: @ContractState) -> u128 {
            let count = self.publisher_count.read();
            if count == 0 { return self.latest_fed_funds_bps.read(); }
            let p1 = self.publishers.read(1);
            if count == 1 { return self.pub_fed_funds_bps.read(p1); }
            let p2 = self.publishers.read(2);
            let v1 = self.pub_fed_funds_bps.read(p1);
            let v2 = self.pub_fed_funds_bps.read(p2);
            if count == 2 { return (v1 + v2) / 2; }
            let p3 = self.publishers.read(3);
            let v3 = self.pub_fed_funds_bps.read(p3);
            _median_of_three(v1, v2, v3)
        }

        fn _aggregate_median_yoy(self: @ContractState) -> u128 {
            let count = self.publisher_count.read();
            if count == 0 { return self.latest_cpi_yoy_bps.read(); }
            let p1 = self.publishers.read(1);
            if count == 1 { return self.pub_cpi_yoy_bps.read(p1); }
            let p2 = self.publishers.read(2);
            let v1 = self.pub_cpi_yoy_bps.read(p1);
            let v2 = self.pub_cpi_yoy_bps.read(p2);
            if count == 2 { return (v1 + v2) / 2; }
            let p3 = self.publishers.read(3);
            let v3 = self.pub_cpi_yoy_bps.read(p3);
            _median_of_three(v1, v2, v3)
        }
    }

    // -------------------------------------------------------
    //  Free functions
    // -------------------------------------------------------

    fn _median_of_three(a: u128, b: u128, c: u128) -> u128 {
        // Branchless median of 3 — returns middle value
        if (a <= b && b <= c) || (c <= b && b <= a) { b }
        else if (b <= a && a <= c) || (c <= a && a <= b) { a }
        else { c }
    }

    // -------------------------------------------------------
    //  Admin accept (called by pending_admin)
    // -------------------------------------------------------
    #[external(v0)]
    fn accept_admin(ref self: ContractState) {
        let caller = get_caller_address();
        assert!(caller == self.pending_admin.read(), "Oracle: not pending admin");
        self.admin.write(caller);
        self.pending_admin.write(starknet::contract_address_const::<0>());
        self.emit(AdminTransferAccepted { new_admin: caller });
    }

    #[external(v0)]
    fn pause(ref self: ContractState) {
        assert!(get_caller_address() == self.admin.read(), "Oracle: not admin");
        self.is_paused.write(true);
        self.emit(OraclePaused { by: get_caller_address() });
    }

    #[external(v0)]
    fn unpause(ref self: ContractState) {
        assert!(get_caller_address() == self.admin.read(), "Oracle: not admin");
        self.is_paused.write(false);
        self.emit(OracleUnpaused { by: get_caller_address() });
    }
}
