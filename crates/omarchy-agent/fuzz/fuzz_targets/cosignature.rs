//! The maintainers' co-signature (#330): a pinned policy, and an armored SSH signature
//! checked against the fixtures' security keys.
#![no_main]

libfuzzer_sys::fuzz_target!(|data: &[u8]| omarchy_agent::fuzz::cosignature(data));
