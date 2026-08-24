/**
 * State AADT Lookup
 * ---------------------------------------------------------------
 * Each state DOT publishes AADT as a public ArcGIS point layer.
 * The dataset *landing pages* below were confirmed to exist, but
 * ArcGIS Online item pages don't always show the raw FeatureServer
 * query URL directly — you may need to open the link, click
 * "View API Resource" / "I want to use this" → "API" to copy the
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

const STATE_ENDPOINTS = {
  TX: {
    label: "TxDOT Annual AADT (Public)",
    // TODO: confirm exact FeatureServer URL from the landing page above
    featureServerUrl: "REPLACE_WITH_CONFIRMED_TXDOT_FEATURESERVER_URL",
    fieldMap: { aadt: "AADT_RPT_QTY", roadName: "RTE_NM", year: "TRAFC_CNT_DT" },
  },
  OK: {
    label: "ODOT AADT Network",
    featureServerUrl: "REPLACE_WITH_CONFIRMED_ODOT_FEATURESERVER_URL",
    // Note: ODOT's layer breaks out AADT by vehicle class (CLASS_01...CLASS_12)
    // which may let you skip the 3%/1% split entirely for OK roads — worth
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

  return (data.features || []).map((f) => ({
    aadt: f.attributes[config.fieldMap.aadt],
    roadName: f.attributes[config.fieldMap.roadName],
    year: f.attributes[config.fieldMap.year],
    rawAttributes: f.attributes,
    lat: f.geometry?.y,
    lng: f.geometry?.x,
  }));
}

/** Filter results to only counts from 2024 or newer, per your standard. */
function filterRecentAADT(results, minYear = 2024) {
  return results.filter((r) => {
    const y = typeof r.year === "number" ? r.year : parseInt(r.year, 10);
    return !isNaN(y) && y >= minYear;
  });
}

export { STATE_ENDPOINTS, findNearbyAADT, filterRecentAADT };
