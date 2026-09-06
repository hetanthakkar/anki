// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

use anki::collection::CollectionBuilder;
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

/// Runtime smoke test that opens Anki's real in-memory collection and asks the
/// real scheduler for its timing/version state. This is intentionally thin:
/// collection creation, schema setup and scheduler behavior stay inside rslib.
#[wasm_bindgen]
pub fn collection_scheduler_smoke() -> Result<String, JsValue> {
    let mut collection = CollectionBuilder::default()
        .build()
        .map_err(|err| JsValue::from_str(&err.to_string()))?;

    let info = collection
        .scheduler_info()
        .map_err(|err| JsValue::from_str(&err.to_string()))?;

    Ok(format!(
        "anki={} scheduler={:?} day={}",
        anki::version::version(),
        info.version,
        info.timing.days_elapsed
    ))
}
