//! The bundle archive and the manifest in it.
#![no_main]

libfuzzer_sys::fuzz_target!(|data: &[u8]| omarchy_agent::fuzz::bundle(data));
