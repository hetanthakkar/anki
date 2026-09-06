// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

use wasm_bindgen::prelude::*;

#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
}

/// Confirms the browser bundle is linked against the real Anki Rust core.
#[wasm_bindgen]
pub fn anki_core_version() -> String {
    anki::version::version().to_owned()
}

/// Compile-time smoke test for the real Anki scheduler module.
///
/// This deliberately does not duplicate scheduling logic. If this crate builds,
/// `anki::scheduler` and its FSRS-backed dependencies compiled for wasm32.
#[wasm_bindgen]
pub fn scheduler_core_available() -> bool {
    let _ = core::mem::size_of::<anki::scheduler::SchedulerInfo>();
    true
}
