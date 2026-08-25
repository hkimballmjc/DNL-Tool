import { calcRoadDNL, calcRailDNL, calcSiteDNL, splitAADT } from "./js/dnl-calc.js";
import { findNearbyAADT, filterRecentAADT, STATE_ENDPOINTS, findTXSpeedLimit, TX_SPEED_LIMITS_URL } from "./js/aadt-lookup.js";
import { findNearbySpeedLimit } from "./js/speed-lookup.js";
import { findNearbyRailCrossings, estimateATO } from "./js/rail-lookup.js";
import { generateSummary } from "./js/summary.js";

let roadSources = [];
let railSources = [];
let roadIdCounter = 0;
let railIdCounter = 0;
let map = null;
let siteMarker = null;
let aadtLayer = null;
let measureActive = false;
let measureMarkers = [];
let measureLine = null;

// ---------- Distance measuring tool (drag-to-adjust, like Google Maps) ----------

const measureIcon = L.divIcon({
  className: "measure-marker",
  html: '<div style="background:#a13a2c;width:14px;height:14px;border-radius:50%;border:2px solid white;box-shadow:0 0 3px rgba(0,0,0,0.6); cursor: grab;"></div>',
  iconSize: [14, 14],
  iconAnchor: [7, 7],
});

function toggleMeasure() {
  measureActive = !measureActive;
  const btn = document.getElementById("measure-btn");
  btn.textContent = measureActive
    ? "Click 2 points to measure (drag pins to adjust)"
    : "Measure distance";
  btn.classList.toggle("btn-primary", measureActive);
}

function clearMeasurement() {
  measureMarkers.forEach((m) => map.removeLayer(m));
  measureMarkers = [];
  if (measureLine) {
    map.removeLayer(measureLine);
    measureLine = null;
  }
  document.getElementById("measure-result").textContent = "";
}

function handleMapClick(e) {
  if (!measureActive) return;
  if (measureMarkers.length >= 2) return; // both pins placed -- drag them instead, or hit Clear

  const marker = L.marker(e.latlng, { icon: measureIcon, draggable: true }).addTo(map);
  marker.on("drag", updateMeasureLine);
  marker.on("dragend", updateMeasureLine);
  measureMarkers.push(marker);

  if (measureMarkers.length === 2) {
    measureLine = L.polyline(
      [measureMarkers[0].getLatLng(), measureMarkers[1].getLatLng()],
      { color: "#a13a2c", weight: 3, dashArray: "6 6" }
    ).addTo(map);
    updateMeasureLine();
  }
}

function updateMeasureLine() {
  if (measureMarkers.length < 2) return;
  const p1 = measureMarkers[0].getLatLng();
  const p2 = measureMarkers[1].getLatLng();
  if (measureLine) measureLine.setLatLngs([p1, p2]);
  const distFt = measureDistanceFeet(p1, p2);
  document.getElementById("measure-result").textContent = `Distance: ${Math.round(distFt).toLocaleString()} ft`;
}

function measureDistanceFeet(p1, p2) {
  const R = 20902231; // Earth's radius in feet
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(p2.lat - p1.lat);
  const dLng = toRad(p2.lng - p1.lng);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(p1.lat)) * Math.cos(toRad(p2.lat)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ---------- Speed limit road layer (persistent, visible while panning) ----------

let speedLayer = null;

function addSpeedLayer(state) {
  if (speedLayer) {
    map.removeLayer(speedLayer);
    speedLayer = null;
  }
  if (state !== "TX" || !window.L.esri) return; // only TX has a confirmed speed dataset so far

  speedLayer = L.esri
    .featureLayer({
      url: TX_SPEED_LIMITS_URL,
      where: "SPD_LMT IS NOT NULL",
      style: () => ({ color: "#2f6b4f", weight: 4, opacity: 0.8 }),
    })
    .bindPopup((layer) => {
      const a = layer.feature.properties;
      const label = [a.RTE_PRFX, a.RTE_NBR, a.RTE_SFX].filter(Boolean).join(" ") || a.RTE_NM || "(unnamed route)";
      return `${label}<br>Speed limit: ${a.SPD_LMT} mph<br><span style="font-size:11px;color:#6b7c94;">Data extracted: ${a.EXT_DATE || "unknown"}</span>`;
    })
    .addTo(map);
}

// ---------- Embedded map ----------

function initMap() {
  map = L.map("map").setView([31.0, -97.5], 6); // default: rough center of Texas
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "&copy; OpenStreetMap contributors",
    maxZoom: 19,
  }).addTo(map);
  map.on("click", handleMapClick);
}

const propertyIcon = L.divIcon({
  className: "property-marker",
  html: '<div style="background:#b5772f;width:18px;height:18px;border-radius:50%;border:3px solid white;box-shadow:0 0 4px rgba(0,0,0,0.6);"></div>',
  iconSize: [18, 18],
  iconAnchor: [9, 9],
});

function showOnMap() {
  const coords = getSiteCoordinates();
  if (!coords) return;
  const { lat, lng } = coords;
  const state = document.getElementById("site-state").value;

  map.setView([lat, lng], 17);

  if (siteMarker) map.removeLayer(siteMarker);
  siteMarker = L.marker([lat, lng], { icon: propertyIcon })
    .addTo(map)
    .bindPopup("Property location (this marker)")
    .openPopup();

  // Swap in the AADT layer for whichever state is selected, if configured
  if (aadtLayer) {
    map.removeLayer(aadtLayer);
    aadtLayer = null;
  }
  const config = STATE_ENDPOINTS[state];
  const legend = document.getElementById("map-legend");
  if (config && !config.featureServerUrl.startsWith("REPLACE_WITH") && window.L.esri) {
    aadtLayer = L.esri
      .featureLayer({ url: config.featureServerUrl })
      .bindPopup((layer) => {
        const a = layer.feature.properties;
        return `${a[config.fieldMap.roadName] || "(unnamed)"}<br>AADT: ${a[config.fieldMap.aadt]} (${a[config.fieldMap.year]})`;
      })
      .addTo(map);
    legend.style.display = "block";
  } else {
    legend.style.display = "none";
  }

  addSpeedLayer(state);
}

// ---------- Shared helpers ----------

/**
 * Reads the combined "Coordinates" field and parses it into {lat, lng}.
 * Accepts formats like "29.5219, -95.0711" or "29.5219 -95.0711".
 * Returns null (and shows an alert) if the field is empty or unparseable.
 */
function getSiteCoordinates() {
  const raw = document.getElementById("site-coords").value.trim();
  if (!raw) {
    alert("Enter site coordinates first (paste from Google Maps).");
    return null;
  }
  const parts = raw.split(/[,\s]+/).map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) {
    alert('Could not read coordinates. Use the format "29.5219, -95.0711".');
    return null;
  }
  const lat = parseFloat(parts[0]);
  const lng = parseFloat(parts[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    alert('Could not read coordinates. Use the format "29.5219, -95.0711".');
    return null;
  }
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    alert("Those coordinates look out of range -- double-check for a missing decimal point.");
    return null;
  }
  return { lat, lng };
}

// ---------- Road Sources ----------

function addRoadSource() {
  const id = roadIdCounter++;
  const source = {
    id,
    roadName: "",
    effectiveDistanceFt: 200,
    distanceToStopSignFt: 600,
    roadGradientPercent: 2,
    aadt: null,
    vehicles: { car: { speed: 35, adt: 0 }, medium: { speed: 30, adt: 0 }, heavy: { speed: 30, adt: 0 } },
    result: null,
  };
  roadSources.push(source);
  renderRoadList();
}

function updateRoadField(id, field, value) {
  const s = roadSources.find((r) => r.id === id);
  if (!s) return;
  if (field.startsWith("vehicle.")) {
    const [, type, prop] = field.split(".");
    s.vehicles[type][prop] = parseFloat(value) || 0;
  } else {
    s[field] = ["roadName"].includes(field) ? value : parseFloat(value) || 0;
  }
}

function applyAADTSplit(id) {
  const s = roadSources.find((r) => r.id === id);
  if (!s || !s.aadt) return;
  const { carADT, mediumADT, heavyADT } = splitAADT(s.aadt);
  s.vehicles.car.adt = Math.round(carADT);
  s.vehicles.medium.adt = Math.round(mediumADT);
  s.vehicles.heavy.adt = Math.round(heavyADT);
  renderRoadList();
}

async function lookupAADTForRoad(id) {
  const s = roadSources.find((r) => r.id === id);
  const coords = getSiteCoordinates();
  if (!coords) return;
  const { lat, lng } = coords;
  const state = document.getElementById("site-state").value;
  const radiiToTry = [0.25, 0.5, 1]; // miles -- widen automatically if nothing found
  try {
    let recent = [];
    let usedRadius = null;
    for (const radius of radiiToTry) {
      const results = await findNearbyAADT(state, lat, lng, radius);
      recent = filterRecentAADT(results);
      if (recent.length > 0) {
        usedRadius = radius;
        break;
      }
    }
    if (recent.length === 0) {
      alert(
        `No 2024+ AADT records found within ${radiiToTry[radiiToTry.length - 1]} miles. ` +
        `This road may not be part of the state highway system this dataset covers, or may need a manual lookup.`
      );
      return;
    }
    showAADTCandidates(id, recent, usedRadius);
  } catch (err) {
    alert(`AADT lookup failed: ${err.message}`);
  }
}

/** Show the nearby AADT matches (closest first) as a pickable list,
 * instead of silently applying whichever one the API returned first. */
function showAADTCandidates(id, candidates, usedRadius) {
  const s = roadSources.find((r) => r.id === id);
  s.aadtCandidates = candidates;
  s.aadtSearchRadius = usedRadius;
  renderRoadList();
}

function chooseAADTCandidate(id, index) {
  const s = roadSources.find((r) => r.id === id);
  const chosen = s.aadtCandidates[index];
  s.aadt = chosen.aadt;
  s.aadtYear = chosen.year;
  s.roadName = chosen.roadName || s.roadName;
  s.aadtCandidates = null;
  applyAADTSplit(id);
}

/** Manual
