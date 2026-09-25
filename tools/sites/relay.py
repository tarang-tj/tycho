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

CAUTION: this is a deliberately simple, labelled-approximate model, not a
precise ephemeris. L2 sits on the extended Earth-Moon line, so leg 1 (Earth
to Queqiao) is modeled as earth_moon_km + queqiao_beyond_moon_km (exact for
a satellite exactly on that line; Queqiao's real halo orbit has an
amplitude up to ~13,000 km off that line per the same Planetary Society
source, so treat this as a nominal figure, not a guaranteed line-of-sight
distance). Leg 2 (Queqiao to a far-side lander near the sub-L2 point) is
modeled as queqiao_beyond_moon_km - moon_radius_km, i.e. the straight-line
distance from Queqiao to the near edge of the Moon facing away from Earth;
Chang'e-4's Von Karman crater site is within a few hundred km of that
sub-L2 point, not exactly on it, so this under-states leg 2 by a small,
unquantified amount that is dominated by the halo-orbit uncertainty above.
"""
from __future__ import annotations

SPEED_OF_LIGHT_KM_S = 299_792.458

EARTH_MOON_KM = 384_400.0  # NASA Moon Fact Sheet, semimajor axis
QUEQIAO_BEYOND_MOON_KM = 65_000.0  # The Planetary Society, nominal L2 halo distance from Moon
MOON_RADIUS_KM = 1_737.4  # NASA Moon Fact Sheet, mean radius


def relay_light_time_sec(earth_moon_km: float = EARTH_MOON_KM,
                          queqiao_beyond_moon_km: float = QUEQIAO_BEYOND_MOON_KM,
                          moon_radius_km: float = MOON_RADIUS_KM) -> tuple[float, list[float]]:
    """Returns (one_way_seconds, [leg1_km, leg2_km]) for Earth -> Queqiao ->
    far-side lander, using the simplified collinear model documented above."""
    leg1_km = earth_moon_km + queqiao_beyond_moon_km
    leg2_km = max(queqiao_beyond_moon_km - moon_radius_km, 0.0)
    total_km = leg1_km + leg2_km
    return total_km / SPEED_OF_LIGHT_KM_S, [leg1_km, leg2_km]
