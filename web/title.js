// Title screen glue. Picks a level card, then on Start closes the overlay and
// hands off to main.js through its existing .level-btn controls (main.js
// owns level loading). The scene watches body.title-open: attract orbit while
// open, cinematic intro when it closes. Also mirrors the active level onto
// <html data-body> so CSS can switch the accent colour per body.
const screen = document.getElementById("title-screen");
const cards = [...document.querySelectorAll(".level-card")];
const startBtn = document.getElementById("titleStart");
let selected = "moon";

function select(level) {
  selected = level;
  for (const card of cards) card.setAttribute("aria-checked", String(card.dataset.level === level));
  document.documentElement.dataset.body = level;
}

// Title's Start is a single step: closing the overlay also begins the
// mission immediately (default delay scenario on Mars), instead of leaving
// a second "Start mission" click gating the HUD brief panel behind it.
function start() {
  if (!document.body.classList.contains("title-open")) return;
  document.body.classList.remove("title-open");
  screen.setAttribute("aria-hidden", "true");
  window.TYCHO?.switchLevel?.(selected, { autoStart: true });
  document.getElementById("sceneCanvas")?.focus({ preventScroll: true });
}

for (const card of cards) {
  card.addEventListener("click", () => select(card.dataset.level));
  card.addEventListener("dblclick", () => { select(card.dataset.level); start(); });
}
startBtn?.addEventListener("click", start);
window.addEventListener("keydown", (event) => {
  if (!document.body.classList.contains("title-open")) return;
  if (event.key === "Enter") { event.preventDefault(); start(); }
  if (event.key === "ArrowRight" || event.key === "ArrowLeft") select(selected === "moon" ? "mars" : "moon");
});

// Keep the accent in sync when the level changes from the top bar.
const syncBody = () => {
  const active = document.querySelector('.level-btn[aria-pressed="true"]');
  if (active && !document.body.classList.contains("title-open")) document.documentElement.dataset.body = active.dataset.level;
};
new MutationObserver(syncBody).observe(document.querySelector(".level-select"), { subtree: true, attributes: true, attributeFilter: ["aria-pressed"] });
select("moon");
