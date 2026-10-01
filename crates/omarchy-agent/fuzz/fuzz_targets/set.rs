//! A set template, and an override after the first NUL byte (`lint-set`).
#![no_main]

libfuzzer_sys::fuzz_target!(|data: &[u8]| omarchy_agent::fuzz::set(data));
