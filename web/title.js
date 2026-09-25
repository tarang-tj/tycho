// Title screen glue. Picks a level card, then on Start closes the overlay and
// hands off to main.js through its existing .level-btn controls (main.js
// owns level loading). The scene watches body.title-open: attract orbit while
// open, cinematic intro when it closes. Also mirrors the active level onto
// <html data-body> so CSS can switch the accent colour per body.
import { isOpen as isAboutOpen } from "./about-data-panel.js";
import { LEVELS, LEVEL_ORDER } from "./levels.js";

const screen = document.getElementById("title-screen");
const cards = [...document.querySelectorAll(".level-card")];
const startBtn = document.getElementById("titleStart");
let selected = LEVEL_ORDER[0];

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
  if (isAboutOpen()) return; // L6: don't let Enter start the game underneath the About dialog
  if (event.key === "Enter") { event.preventDefault(); start(); }
  if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
    const i = LEVEL_ORDER.indexOf(selected);
    const dir = event.key === "ArrowRight" ? 1 : -1;
    select(LEVEL_ORDER[(i + dir + LEVEL_ORDER.length) % LEVEL_ORDER.length]);
  }
});

// Keep the accent in sync when the level changes from the top bar.
const syncBody = () => {
  const active = document.querySelector('.level-btn[aria-pressed="true"]');
  if (active && !document.body.classList.contains("title-open")) document.documentElement.dataset.body = active.dataset.level;
};
new MutationObserver(syncBody).observe(document.querySelector(".level-select"), { subtree: true, attributes: true, attributeFilter: ["aria-pressed"] });
select(LEVEL_ORDER[0]);

// New sites (Chang'e-4, Opportunity, Apollo 17) ship as config-driven cards
// immediately - the engine already falls back to synthetic terrain with an
// on-screen banner if a level's assets aren't in this checkout (see
// terrain-data.js) - but the card itself should say so up front rather than
// let the player discover it only after Start. Non-blocking: a level is
// still fully playable (on synthetic terrain) while this check is pending
// or fails closed (treated as unavailable).
async function markPendingCards() {
  await Promise.all(cards.map(async (card) => {
    const level = LEVELS[card.dataset.level];
    if (!level) return;
    let available = false;
    try {
      const res = await fetch(`../assets/${level.assetKey}/meta.json`, { method: "HEAD" });
      available = res.ok;
    } catch {
      available = false;
    }
    if (available) return;
    card.classList.add("level-card--pending");
    const note = card.querySelector(".card-note");
    if (note) note.textContent = "Terrain not yet available - plays on a synthetic preview";
  }));
}
markPendingCards();
