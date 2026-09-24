// "About the data" panel glue: opens/closes a static honesty disclosure
// (what's real DEM, what's procedural, why the Earth position is
// approximate, why Mars's delay is compressed, and that everything on the
// HUD is telemetry from the past). No dependency on main.js/TYCHO state -
// the panel's content is static and body-agnostic by design.
//
// M9: focus moves into the dialog on open, Tab is trapped inside it while
// open, Escape closes it, and focus returns to whatever opened it.
const panel = document.getElementById("aboutDataPanel");
const openButtons = [document.getElementById("aboutDataBtn"), document.getElementById("titleAboutDataBtn")];
const closeButton = document.getElementById("aboutDataClose");
let lastFocused = null;

function focusableEls() {
  return [...panel.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
    .filter((node) => !node.disabled && node.getClientRects().length > 0);
}

function open() {
  lastFocused = document.activeElement;
  panel.hidden = false;
  closeButton?.focus();
}

function close() {
  panel.hidden = true;
  const toFocus = lastFocused;
  lastFocused = null;
  toFocus?.focus?.();
}

/** True while the dialog is open - used by title.js to block Enter from
 * starting the game underneath the dialog (L6). */
export function isOpen() {
  return !panel.hidden;
}

for (const btn of openButtons) btn?.addEventListener("click", open);
closeButton?.addEventListener("click", close);
panel?.addEventListener("click", (event) => {
  if (event.target === panel) close(); // click on the dimmed backdrop
});
window.addEventListener("keydown", (event) => {
  if (panel.hidden) return;
  if (event.key === "Escape") {
    close();
    return;
  }
  if (event.key !== "Tab") return;
  const focusables = focusableEls();
  if (!focusables.length) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
});
