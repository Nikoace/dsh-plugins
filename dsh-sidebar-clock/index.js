/**
 * Host half of the sidebar-clock bundle.
 *
 * The card is pure Client UI: it reads the wall clock, classifies the current
 * DeepSeek peak/off-peak band from the published UTC windows, and counts down
 * to the next weekend and Chinese public holiday. The holiday calendar is
 * fetched in the browser (timor.tech reflects the page origin, so no Host
 * proxy is needed). Nothing here is model-facing.
 */
export function apply() {}
