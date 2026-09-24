// "Copy result" clipboard handling, split out of hud.js (U4). Copies via
// the async Clipboard API and falls back to a readonly textarea +
// execCommand("copy") if that's unavailable or throws (e.g. an insecure
// context or a denied permission). Never throws back to the caller.

/** Copy `text`, briefly changing `statusBtn`'s label to "Copied" on success. */
export function copyResultText(text, statusBtn) {
  const showCopied = () => {
    const original = statusBtn.textContent;
    statusBtn.textContent = "Copied";
    setTimeout(() => { statusBtn.textContent = original; }, 1500);
  };
  try {
    navigator.clipboard.writeText(text).then(showCopied).catch(() => fallbackCopy(text, showCopied));
  } catch {
    fallbackCopy(text, showCopied);
  }
}

function fallbackCopy(text, onDone) {
  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.readOnly = true;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    document.body.removeChild(textarea);
    onDone();
  } catch {
    // Clipboard truly unavailable: the text is still visible in the end
    // card's own copy, so nothing else to do here.
  }
}
