//! The manifest's outer and inner layers (`verify --bundle`, once signed).
#![no_main]

libfuzzer_sys::fuzz_target!(|data: &[u8]| omarchy_agent::fuzz::manifest(data));
