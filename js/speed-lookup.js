/**
 * Posted Speed Limit Lookup (best-effort, via OpenStreetMap)
 * ---------------------------------------------------------------
 * OSM tags road segments with `maxspeed` where it's been surveyed
 * or imported from state data. Coverage is good on highways/major
 * arterials, spottier on local streets - always show this as a
 * suggested value the user can override, never as a silent final answer.
 * ---------------------------------------------------------------
 */

const OVERPASS_ENDPOINT = "https://overpass-api.de/api/interpreter";

/**
 * Find the nearest tagged speed limit within radiusMeters of a point.
 * @param {number} lat
 * @param {number} lng
 * @param {number} radiusMeters - default 150 (~500ft)
 */
async function findNearbySpeedLimit(lat, lng, radiusMeters = 150) {
  const query = `
    [out:json][timeout:15];
    way(around:${radiusMeters},${lat},${lng})["highway"]["maxspeed"];
    out tags center;
  `;

  const res = await fetch(OVERPASS_ENDPOINT, {
    method: "POST",
    body: new URLSearchParams({ data: query }),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  if (!res.ok) throw new Error(`Overpass query failed: ${res.status}`);
  const data = await res.json();

  return (data.elements || []).map((el) => ({
    roadName: el.tags?.name || "(unnamed)",
    maxspeedRaw: el.tags?.maxspeed, // e.g. "35 mph" or just "35"
    maxspeedMph: parseMaxspeed(el.tags?.maxspeed),
    highwayType: el.tags?.highway,
    lat: el.center?.lat ?? null,
    lng: el.center?.lon ?? null,
  }));
}

function parseMaxspeed(raw) {
  if (!raw) return null;
  const match = raw.match(/(\d+)\s*(mph)?/i);
  if (!match) return null;
  const value = parseInt(match[1], 10);
  // OSM defaults to km/h unless "mph" is specified; US data is almost
  // always tagged in mph explicitly, but double-check on edge cases.
  return raw.toLowerCase().includes("mph") || !raw.includes(" ") ? value : Math.round(value * 0.621371);
}

/**
 * Find OSM ways tagged with a speed limit near a point, returning full
 * line geometry (not just a center point) so they can be drawn on the
 * map as a fallback layer for streets the state DOT data doesn't cover.
 * @param {number} lat
 * @param {number} lng
 * @param {number} radiusMeters
 */
async function findSpeedLimitWaysWithGeometry(lat, lng, radiusMeters = 1609) {
  const query = `
    [out:json][timeout:20];
    way(around:${radiusMeters},${lat},${lng})["highway"]["maxspeed"];
    out geom;
  `;

  const res = await fetch(OVERPASS_ENDPOINT, {
    method: "POST",
    body: new URLSearchParams({ data: query }),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  if (!res.ok) throw new Error(`Overpass query failed: ${res.status}`);
  const data = await res.json();

  return (data.elements || [])
    .map((el) => ({
      roadName: el.tags?.name || "(unnamed)",
      maxspeedMph: parseMaxspeed(el.tags?.maxspeed),
      points: (el.geometry || []).map((p) => [p.lat, p.lon]),
    }))
    .filter((w) => w.maxspeedMph && w.points.length > 1);
}

export { findNearbySpeedLimit, findSpeedLimitWaysWithGeometry };
