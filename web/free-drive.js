// Free drive: an opt-in, clearly labeled NOT-realistic mode for casual play.
// On live-drive (Moon) levels it removes the signal delay entirely. Mars
// stays realistic (its plan-and-trust loop IS the delay). Free-drive runs
// are never recorded on the scoreboard, never scored against par or
// objectives, and their share line says so.

// "not realistic" leads so it survives the one-line truncation on phones.
export const FREE_DRIVE_NOTE = "Free drive (not realistic): no signal delay, not counted on the scoreboard.";
export const FREE_DRIVE_ENDCARD_NOTE = "Free drive run: no signal delay, not realistic, not counted.";

/** Whether free drive actually applies to a run on this level. */
export function freeDriveApplies(level, enabled) {
  return !!enabled && level?.mode === "live";
}

/** The one-way delay a run uses: 0 in free drive, the real value otherwise. */
export function runDelaySec(realDelaySec, applies) {
  return applies ? 0 : realDelaySec;
}
