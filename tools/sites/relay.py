"""Far-side relay-delay geometry (Earth -> Queqiao -> lunar farside lander).

Sourced numbers (fetched 2026-09-24):
- Earth-Moon mean distance 384,400 km: NASA "Moon Fact Sheet"
  (https://nssdc.gsfc.nasa.gov/planetary/factsheet/moonfact.html), "Semimajor
  axis (km) 384,400".
- Queqiao relay satellite operates in an Earth-Moon L2 halo orbit "about
  65,000 kilometers from the Moon": The Planetary Society, "How China's
  lunar relay satellite arrived in its final orbit"
  (https://www.planetary.org/articles/20180615-queqiao-orbit-explainer).
- Moon mean radius 1,737.4 km: NASA "Moon Fact Sheet" (same source as above).

- Queqiao's halo-orbit Z-amplitude (~13,000 km) and its 47,000-79,000 km
  range of distance from the Moon: "Development and Prospect of Chinese
  Lunar Relay Communication Satellite", Space: Science & Technology 2021
  (https://spj.science.org/doi/10.34133/2021/3471608). These figures are
  NOT in the Planetary Society source above, which only states the nominal
  ~65,000 km distance; they are cited to this SPJ 2021 paper instead.

CAUTION: this is a deliberately simple, labelled-approximate model, not a
precise ephemeris. L2 sits on the extended Earth-Moon line, so leg 1 (Earth
to Queqiao) is modeled as earth_moon_km + queqiao_beyond_moon_km (exact for
a satellite exactly on that line; Queqiao's real halo orbit has an
amplitude up to ~13,000 km off that line per the SPJ 2021 source above, so
treat this as a nominal figure, not a guaranteed line-of-sight distance).
Leg 2 (Queqiao to a far-side lander near the sub-L2 point) is modeled as
queqiao_beyond_moon_km - moon_radius_km, i.e. the straight-line distance
from Queqiao to the near edge of the Moon facing away from Earth;
Chang'e-4's Von Karman crater site (45.457S, 177.589E) is about 1,400 km of
arc from the sub-L2 point (0deg, 180deg), not exactly on it. The extra
leg-2 distance this actually costs is small: the true leg-2 distance from
that offset is about 63,790 km against the modeled 63,263 km, roughly +1.8
ms one way -- well inside the halo-orbit uncertainty above, and dominated
by it.
"""
from __future__ import annotations

SPEED_OF_LIGHT_KM_S = 299_792.458

EARTH_MOON_KM = 384_400.0  # NASA Moon Fact Sheet, semimajor axis
QUEQIAO_BEYOND_MOON_KM = 65_000.0  # The Planetary Society, nominal L2 halo distance from Moon
MOON_RADIUS_KM = 1_737.4  # NASA Moon Fact Sheet, mean radius

# Human-readable HUD path label for this relay link. Matches web/levels.js's
# LEVELS.change4.delay.pathLabel exactly, so the fallback and the real
# meta.delayModel.pathLabel read the same on screen either way (see
# resolveDelayLabel in web/levels.js).
RELAY_PATH_LABEL = "Earth > Queqiao relay > far side"


def relay_light_time_sec(earth_moon_km: float = EARTH_MOON_KM,
                          queqiao_beyond_moon_km: float = QUEQIAO_BEYOND_MOON_KM,
                          moon_radius_km: float = MOON_RADIUS_KM) -> tuple[float, list[float]]:
    """Returns (one_way_seconds, [leg1_km, leg2_km]) for Earth -> Queqiao ->
    far-side lander, using the simplified collinear model documented above."""
    leg1_km = earth_moon_km + queqiao_beyond_moon_km
    leg2_km = max(queqiao_beyond_moon_km - moon_radius_km, 0.0)
    total_km = leg1_km + leg2_km
    return total_km / SPEED_OF_LIGHT_KM_S, [leg1_km, leg2_km]
