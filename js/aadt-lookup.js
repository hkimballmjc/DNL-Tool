/**
 * State AADT Lookup
 * ---------------------------------------------------------------
 * Each state DOT publishes AADT as a public ArcGIS point layer.
 * The dataset *landing pages* below were confirmed to exist, but
 * ArcGIS Online item pages don't always show the raw FeatureServer
 * query URL directly - you may need to open the link, click
 * "View API Resource" / "I want to use this" -> "API" to copy the
 * exact REST endpoint into the STATE_ENDPOINTS config below.
 *
 * How to find a FeatureServer URL from a hub/item page:
 *   1. Open the dataset page (links below)
 *   2. Look for a button like "View API Resource" or "I want to use this"
 *   3. Copy the URL ending in .../FeatureServer/0 (or /MapServer/0)
 *   4. Paste it into STATE_ENDPOINTS below
 *
 * Landing pages found (confirm + fill in the REST endpoint):
 *   TX (TxDOT):  https://gis-txdot.opendata.arcgis.com/datasets/TXDOT::txdot-annual-average-daily-traffic-counts-public/about
 *   OK (ODOT):   https://spotlight-okdot.hub.arcgis.com/datasets/aadt-network
 *   TN (TDOT):   https://tn-tnmap.opendata.arcgis.com/datasets/63b320c471604ad786d99c5f88172b5e_0
 *   AR (ArDOT):  https://addt-ardot.hub.arcgis.com/
 * ---------------------------------------------------------------
 */

/**
 * Links to open the state's live traffic map in a new tab, centered on
 * the property coordinates where possible, so the AADT number can be
 * read directly off the official source instead of relying on an
 * automated point-match (which can grab the wrong nearby road/segment).
 */
const STATE_MAP_LINKS = {
  TX: (lat, lng) =>
    `https://www.arcgis.com/apps/mapviewer/index.html?layers=d5f56ecd2b274b4d8dc3c2d6fe067d37&center=${lng},${lat}&level=18`,
  // OK/TN/AR: exact dataset item IDs not yet confirmed, so these open
  // the dataset landing page instead -- click "View Map" there, then
  // search/pan to the coordinates manually.
  OK: () => "https://spotlight-okdot.hub.arcgis.com/datasets/aadt-network",
  TN: () => "https://tn-tnmap.opendata.arcgis.com/datasets/63b320c471604ad786d99c5f88172b5e_0",
  AR: () => "https://addt-ardot.hub.arcgis.com/",
};

function getStateMapLink(state, lat, lng) {
  const fn = STATE_MAP_LINKS[state];
  return fn ? fn(lat, lng) : null;
}

const STATE_ENDPOINTS = {
  TX: {
    label: "TxDOT AADT Annuals (Public View)",
    featureServerUrl:
      "https://services.arcgis.com/KTcxiTD9dsQw4r7Z/arcgis/rest/services/TxDOT_AADT_Annuals_(Public_View)/FeatureServer/0",
    // Confirmed field names as of this layer's current schema:
    // AADT_RPT_QTY = most recent year's AADT, AADT_RPT_YEAR = that year.
    // ON_ROAD = road name. (Older years are in AADT_RPT_HIST_01_QTY etc,
    // not used here since we only want 2024+.)
    fieldMap: { aadt: "AADT_RPT_QTY", roadName: "ON_ROAD", year: "AADT_RPT_YEAR" },
  },
  OK: {
    label: "ODOT AADT Network",
    featureServerUrl: "REPLACE_WITH_CONFIRMED_ODOT_FEATURESERVER_URL",
    // Note: ODOT's layer breaks out AADT by vehicle class (CLASS_01...CLASS_12)
    // which may let you skip the 3%/1% split entirely for OK roads - worth
    // checking once you have real query results back.
    fieldMap: { aadt: "AADT", roadName: "FC_RD_ID", year: "YEAR" },
  },
  TN: {
    label: "TDOT Traffic History / Lines",
    featureServerUrl: "REPLACE_WITH_CONFIRMED_TDOT_FEATURESERVER_URL",
    fieldMap: { aadt: "AADT", roadName: "ROUTE_ID", year: "YEAR" },
  },
  AR: {
    label: "ArDOT Average Daily Traffic",
    featureServerUrl: "REPLACE_WITH_CONFIRMED_ARDOT_FEATURESERVER_URL",
    fieldMap: { aadt: "ADT", roadName: "ROUTE_ID", year: "YEAR" },
  },
};

const MILES_TO_METERS = 1609.34;

/** Straight-line distance in feet between two lat/lng points (Haversine). */
function distanceFeet(lat1, lng1, lat2, lng2) {
  const R = 20902231; // Earth's radius in feet
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Query a state's AADT layer for the nearest points/segments to a
 * lat/lng, within a search radius.
 * @param {"TX"|"OK"|"TN"|"AR"} state
 * @param {number} lat
 * @param {number} lng
 * @param {number} radiusMiles - default 0.25 (adjust as needed)
 */
async function findNearbyAADT(state, lat, lng, radiusMiles = 0.25) {
  const config = STATE_ENDPOINTS[state];
  if (!config) throw new Error(`No AADT config for state: ${state}`);
  if (config.featureServerUrl.startsWith("REPLACE_WITH")) {
    throw new Error(
      `${state} AADT endpoint not yet configured. See comments in aadt-lookup.js.`
    );
  }

  const params = new URLSearchParams({
    f: "json",
    geometry: `${lng},${lat}`,
    geometryType: "esriGeometryPoint",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    distance: String(radiusMiles * MILES_TO_METERS),
    units: "esriSRUnit_Meter",
    outFields: "*",
    returnGeometry: true,
    outSR: "4326",
  });

  const url = `${config.featureServerUrl}/query?${params.toString()}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${state} AADT query failed: ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(`${state} AADT query error: ${data.error.message}`);

  const results = (data.features || []).map((f) => ({
    aadt: f.attributes[config.fieldMap.aadt],
    roadName: f.attributes[config.fieldMap.roadName],
    year: f.attributes[config.fieldMap.year],
    rawAttributes: f.attributes,
    lat: f.geometry?.y,
    lng: f.geometry?.x,
    distanceFt:
      f.geometry?.y && f.geometry?.x
        ? distanceFeet(lat, lng, f.geometry.y, f.geometry.x)
        : null,
  }));

  // Closest matches first -- ArcGIS does NOT sort by distance by default,
  // so without this the "first result" can easily be a station further
  // away or on a different road than the one you're actually measuring.
  results.sort((a, b) => (a.distanceFt ?? Infinity) - (b.distanceFt ?? Infinity));

  return results;
}

/** Filter results to only counts from 2024 or newer, per your standard. */
function filterRecentAADT(results, minYear = 2024) {
  return results.filter((r) => {
    const y = typeof r.year === "number" ? r.year : parseInt(r.year, 10);
    return !isNaN(y) && y >= minYear;
  });
}

export { STATE_ENDPOINTS, findNearbyAADT, filterRecentAADT, getStateMapLink };

/**
 * TxDOT's own roadway inventory includes posted speed limit as a direct
 * attribute (SPD_MAX / ALT_SPD_LMT) for state-maintained roads -- this is
 * far more reliable than OpenStreetMap's crowdsourced tagging, though it
 * only covers state highways/FM roads, not city streets.
 * Confirmed live endpoint: services.arcgis.com/.../TxDOT_Roadway_Inventory
 */
const TX_ROADWAY_INVENTORY_URL =
  "https://services.arcgis.com/KTcxiTD9dsQw4r7Z/arcgis/rest/services/TxDOT_Roadway_Inventory/FeatureServer/0";

async function findTXSpeedLimit(lat, lng, radiusMiles = 0.25) {
  const params = new URLSearchParams({
    f: "json",
    geometry: `${lng},${lat}`,
    geometryType: "esriGeometryPoint",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    distance: String(radiusMiles * MILES_TO_METERS),
    units: "esriSRUnit_Meter",
    outFields: "SPD_MAX,ALT_SPD_LMT,ALT_SPD_LMT_TYPE,STE_NAM,SCHOOL_ZN",
    returnGeometry: true,
    outSR: "4326",
  });
  const url = `${TX_ROADWAY_INVENTORY_URL}/query?${params.toString()}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`TX roadway inventory query failed: ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(`TX roadway inventory query error: ${data.error.message}`);

  const results = (data.features || [])
    .map((f) => {
      const speedMph = f.attributes.SPD_MAX || f.attributes.ALT_SPD_LMT || null;
      // This dataset stores roads as line segments (speed can change block
      // to block), so find the closest point on THIS segment to the query
      // point, not just whether it's anywhere within the search radius.
      let minDist = Infinity;
      const paths = f.geometry?.paths || [];
      for (const path of paths) {
        for (const vertex of path) {
          const d = distanceFeet(lat, lng, vertex[1], vertex[0]);
          if (d < minDist) minDist = d;
        }
      }
      return {
        speedMph,
        roadName: f.attributes.STE_NAM,
        schoolZone: f.attributes.SCHOOL_ZN,
        distanceFt: Number.isFinite(minDist) ? minDist : null,
      };
    })
    .filter((r) => r.speedMph);

  // Closest segment first -- critical here, since speed limits genuinely
  // change from block to block along the same road (school zones, city
  // limits, etc), so "any match in the radius" is not good enough.
  results.sort((a, b) => (a.distanceFt ?? Infinity) - (b.distanceFt ?? Infinity));
  return results;
}

export { findTXSpeedLimit };
