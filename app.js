import { calcRoadDNL, calcRailDNL, calcSiteDNL, splitAADT } from "./js/dnl-calc.js";
import { findNearbyAADT, filterRecentAADT } from "./js/aadt-lookup.js";
import { findNearbySpeedLimit } from "./js/speed-lookup.js";
import { findNearbyRailCrossings, estimateATO } from "./js/rail-lookup.js";
import { generateSummary } from "./js/summary.js";

let roadSources = [];
let railSources = [];
let roadIdCounter = 0;
let railIdCounter = 0;

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
  try {
    const results = await findNearbyAADT(state, lat, lng);
    const recent = filterRecentAADT(results);
    if (recent.length === 0) {
      alert("No 2024+ AADT records found nearby - check the endpoint config or widen the search radius.");
      return;
    }
    // naive pick: first result - in real use, let the user choose from a list
    s.aadt = recent[0].aadt;
    s.roadName = s.roadName || recent[0].roadName || "";
    applyAADTSplit(id);
  } catch (err) {
    alert(`AADT lookup failed: ${err.message}`);
  }
}

async function lookupSpeedForRoad(id) {
  const s = roadSources.find((r) => r.id === id);
  const coords = getSiteCoordinates();
  if (!coords) return;
  const { lat, lng } = coords;
  try {
    const results = await findNearbySpeedLimit(lat, lng);
    const withSpeed = results.find((r) => r.maxspeedMph);
    if (!withSpeed) {
      alert("No posted speed limit found nearby via OpenStreetMap - enter manually.");
      return;
    }
    s.vehicles.car.speed = withSpeed.maxspeedMph;
    s.vehicles.medium.speed = Math.max(withSpeed.maxspeedMph - 5, 0);
    s.vehicles.heavy.speed = Math.max(withSpeed.maxspeedMph - 5, 0);
    renderRoadList();
  } catch (err) {
    alert(`Speed limit lookup failed: ${err.message}`);
  }
}

function calcRoad(id) {
  const s = roadSources.find((r) => r.id === id);
  const vehicles = ["car", "medium", "heavy"]
    .filter((type) => s.vehicles[type].adt > 0)
    .map((type) => ({
      vehicleType: type,
      speedMph: s.vehicles[type].speed,
      adt: s.vehicles[type].adt,
      nightFraction: 0.15,
    }));

  if (vehicles.length === 0) {
    alert("Enter ADT for at least one vehicle type.");
    return;
  }

  const { roadDNL, perVehicleDNL } = calcRoadDNL(vehicles, {
    effectiveDistanceFt: s.effectiveDistanceFt,
    distanceToStopSignFt: s.distanceToStopSignFt,
    roadGradientPercent: s.roadGradientPercent,
  });

  s.result = { roadDNL, perVehicleDNL };
  renderRoadList();
}

function removeRoad(id) {
  roadSources = roadSources.filter((r) => r.id !== id);
  renderRoadList();
}

function renderRoadList() {
  const container = document.getElementById("road-list");
  container.innerHTML = "";
  roadSources.forEach((s) => {
    const card = document.createElement("div");
    card.className = "road-source-card";
    card.innerHTML = `
      <div class="source-header">
        <h3>Road #${s.id + 1}${s.roadName ? `: ${s.roadName}` : ""}</h3>
        <button class="remove-btn" data-action="remove-road" data-id="${s.id}">remove</button>
      </div>
      <div class="field-row">
        <label>Road name
          <input type="text" value="${s.roadName}" data-action="field" data-id="${s.id}" data-field="roadName" />
        </label>
        <label>Effective distance (ft)
          <input type="number" value="${s.effectiveDistanceFt}" data-action="field" data-id="${s.id}" data-field="effectiveDistanceFt" />
        </label>
        <label>Distance to stop sign (ft, 600 = none)
          <input type="number" value="${s.distanceToStopSignFt}" data-action="field" data-id="${s.id}" data-field="distanceToStopSignFt" />
        </label>
        <label>Road gradient (%)
          <input type="number" value="${s.roadGradientPercent}" data-action="field" data-id="${s.id}" data-field="roadGradientPercent" />
        </label>
      </div>
      <div class="field-row">
        <button class="btn-secondary" data-action="lookup-aadt" data-id="${s.id}">Find AADT (state lookup)</button>
        <button class="btn-secondary" data-action="lookup-speed" data-id="${s.id}">Find speed limit (OSM)</button>
        ${s.aadt ? `<span class="hint">Raw AADT: ${s.aadt}</span>` : ""}
      </div>
      <div class="vehicle-row head"><div>Type</div><div>Speed (mph)</div><div>ADT</div><div></div><div></div></div>
      ${["car", "medium", "heavy"]
        .map(
          (type) => `
        <div class="vehicle-row">
          <div>${type}</div>
          <input type="number" value="${s.vehicles[type].speed}" data-action="field" data-id="${s.id}" data-field="vehicle.${type}.speed" />
          <input type="number" value="${s.vehicles[type].adt}" data-action="field" data-id="${s.id}" data-field="vehicle.${type}.adt" />
          <div></div><div></div>
        </div>`
        )
        .join("")}
      <div class="field-row" style="margin-top:10px;">
        <button class="btn-primary" data-action="calc-road" data-id="${s.id}">Calculate Road #${s.id + 1} DNL</button>
      </div>
      ${
        s.result
          ? `<table class="result-table">
              <tr><th>Vehicle</th><th>DNL (dB)</th></tr>
              ${s.result.perVehicleDNL.map((v) => `<tr><td>${v.type}</td><td>${v.dnl.toFixed(1)}</td></tr>`).join("")}
              <tr><th>Road DNL</th><th>${s.result.roadDNL.toFixed(1)}</th></tr>
            </table>`
          : ""
      }
    `;
    container.appendChild(card);
  });
}

// ---------- Rail Sources ----------

function addRailSource(prefill = {}) {
  const id = railIdCounter++;
  railSources.push({
    id,
    trackIdentifier: prefill.trackIdentifier || "",
    engineType: prefill.engineType || "diesel",
    distanceToTrackFt: prefill.distanceToTrackFt || 500,
    averageTrainOperations: prefill.averageTrainOperations || null,
    result: null,
  });
  renderRailList();
}

async function searchRail() {
  const coords = getSiteCoordinates();
  if (!coords) return;
  const { lat, lng } = coords;
  const resultsDiv = document.getElementById("rail-results");
  resultsDiv.innerHTML = "Searching FRA crossing inventory...";
  try {
    const crossings = await findNearbyRailCrossings(lat, lng, 1);
    if (crossings.length === 0) {
