// "About the data" panel glue: opens/closes a static honesty disclosure
// (what's real DEM, what's procedural, why the Earth position is
// approximate, why Mars's delay is compressed, and that everything on the
// HUD is telemetry from the past). No dependency on main.js/TYCHO state -
// the panel's content is static and body-agnostic by design.
const panel = document.getElementById("aboutDataPanel");
const openButtons = [document.getElementById("aboutDataBtn"), document.getElementById("titleAboutDataBtn")];
const closeButton = document.getElementById("aboutDataClose");

function open() {
  panel.hidden = false;
}

function close() {
  panel.hidden = true;
}

for (const btn of openButtons) btn?.addEventListener("click", open);
closeButton?.addEventListener("click", close);
panel?.addEventListener("click", (event) => {
  if (event.target === panel) close(); // click on the dimmed backdrop
});
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !panel.hidden) close();
});
