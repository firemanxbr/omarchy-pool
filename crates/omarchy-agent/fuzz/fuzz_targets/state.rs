//! `state.json` as the run loop reads it after a restart, and the pool's `follow` answer.
#![no_main]

libfuzzer_sys::fuzz_target!(|data: &[u8]| omarchy_agent::fuzz::state(data));
