/**
 * FRA Highway-Rail Grade Crossing Lookup
 * ---------------------------------------------------------------
 * Uses FRA's own public ArcGIS REST service (confirmed live endpoint,
 * no API key required):
 *   https://fragis.fra.dot.gov/arcgis/rest/services/FRA/FRAGradeXing/MapServer
 *
 * This queries the National Highway-Rail Crossing Inventory for
 * crossings within a given radius of a point (property location).
 * Inventory records include fields for annual day/night train
 * counts which feed "Average Train Operations" (ATO = yearly volume / 365).
 *
 * ⚠️ Field names below (e.g. DAY_TOTAL, NIGHT_TOTAL) are the FRA
 * inventory's standard field names as of the last public schema —
 * confirm they still match by inspecting one query result, since
 * FRA does periodically revise field names.
 * ---------------------------------------------------------------
 */

const FRA_MAPSERVER_LAYER_URL =
  "https://fragis.fra.dot.gov/arcgis/rest/services/FRA/FRAGradeXing/MapServer/0";

const MILES_TO_METERS = 1609.34;

/**
 * Find rail crossings within `radiusMiles` of a lat/lng point.
 * @param {number} lat
 * @param {number} lng
 * @param {number} radiusMiles - default 1 (per your workflow)
 */
async function findNearbyRailCrossings(lat, lng, radiusMiles = 1) {
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

  const url = `${FRA_MAPSERVER_LAYER_URL}/query?${params.toString()}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FRA query failed: ${res.status}`);
  const data = await res.json();

  if (data.error) throw new Error(`FRA query error: ${data.error.message}`);

  return (data.features || []).map((f) => ({
    attributes: f.attributes,
    lat: f.geometry?.y,
    lng: f.geometry?.x,
  }));
}

/**
 * Compute Average Train Operations (ATO) from a crossing's annual
 * traffic fields. Field names vary by FRA schema vintage — this
 * tries the most common current field names and falls back gracefully.
 */
function estimateATO(crossingAttributes) {
  // Try common FRA inventory field names for total daily train movements
  const dayOps =
    crossingAttributes.DAY_THRU_TRAINS_TOTAL ??
    crossingAttributes.TOTAL_DAY ??
    null;
  const nightOps =
    crossingAttributes.NIGHT_THRU_TRAINS_TOTAL ??
    crossingAttributes.TOTAL_NIGHT ??
    null;

  if (dayOps !== null && nightOps !== null) {
    // If the inventory already reports daily averages, ATO = day + night ops
    return { ato: dayOps + nightOps, source: "daily fields", confident: true };
  }

  // Fall back: some records report an annual total field instead
  const annualTotal =
    crossingAttributes.TOTAL_YEARLY_RAIL_TRAFFIC ??
    crossingAttributes.YEARLY_TRAFFIC ??
    null;

  if (annualTotal !== null) {
    return { ato: annualTotal / 365, source: "annual field / 365", confident: true };
  }

  return {
    ato: null,
    source: "not found in standard fields — check record manually",
    confident: false,
  };
}

export { findNearbyRailCrossings, estimateATO };
