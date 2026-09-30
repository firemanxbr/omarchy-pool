//! A rollback statement (`verify --statement`, once signed).
#![no_main]

libfuzzer_sys::fuzz_target!(|data: &[u8]| omarchy_agent::fuzz::statement(data));
