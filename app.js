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
      resultsDiv.innerHTML = "<p class='hint'>No FRA-registered crossings found within 1 mile.</p>";
      return;
    }
    resultsDiv.innerHTML = `<p class="hint">${crossings.length} crossing(s) found. Click to add as a rail source:</p>`;
    crossings.forEach((c) => {
      const ato = estimateATO(c.attributes);
      const btn = document.createElement("button");
      btn.className = "btn-secondary";
      btn.style.display = "block";
      btn.style.marginBottom = "6px";
      btn.textContent = `${c.attributes.RAILROAD || c.attributes.RRCARRIER || "Crossing"} - ATO: ${
        ato.ato !== null ? ato.ato.toFixed(1) : "not found (" + ato.source + ")"
      }`;
      btn.addEventListener("click", () => {
        addRailSource({
          trackIdentifier: c.attributes.RAILROAD || c.attributes.RRCARRIER || "",
          averageTrainOperations: ato.ato,
        });
      });
      resultsDiv.appendChild(btn);
    });
  } catch (err) {
    resultsDiv.innerHTML = `<p class="hint">FRA lookup failed: ${err.message}</p>`;
  }
}

function updateRailField(id, field, value) {
  const s = railSources.find((r) => r.id === id);
  if (!s) return;
  s[field] = field === "trackIdentifier" || field === "engineType" ? value : parseFloat(value) || 0;
}

function calcRail(id) {
  const s = railSources.find((r) => r.id === id);
  if (!s.averageTrainOperations) {
    alert("Enter Average Train Operations (ATO) for this rail source.");
    return;
  }
  const isElectric = s.engineType === "electric";
  const result = calcRailDNL({
    engineType: s.engineType,
    engines: isElectric ? 1 : 2,
    cars: isElectric ? 8 : 50,
    speedMph: 30,
    distanceToTrackFt: s.distanceToTrackFt,
    averageTrainOperations: s.averageTrainOperations,
    nightFractionATO: 0.15,
  });
  s.result = result;
  renderRailList();
}

function removeRail(id) {
  railSources = railSources.filter((r) => r.id !== id);
  renderRailList();
}

function renderRailList() {
  const container = document.getElementById("rail-list");
  container.innerHTML = "";
  railSources.forEach((s) => {
    const card = document.createElement("div");
    card.className = "rail-source-card";
    card.innerHTML = `
      <div class="source-header">
        <h3>Rail #${s.id + 1}${s.trackIdentifier ? `: ${s.trackIdentifier}` : ""}</h3>
        <button class="remove-btn" data-action="remove-rail" data-id="${s.id}">remove</button>
      </div>
      <div class="field-row">
        <label>Track identifier
          <input type="text" value="${s.trackIdentifier}" data-action="rail-field" data-id="${s.id}" data-field="trackIdentifier" />
        </label>
        <label>Engine type
          <select data-action="rail-field" data-id="${s.id}" data-field="engineType">
            <option value="diesel" ${s.engineType === "diesel" ? "selected" : ""}>Diesel (2 engines / 50 cars)</option>
            <option value="electric" ${s.engineType === "electric" ? "selected" : ""}>Electric (1 engine / 8 cars)</option>
          </select>
        </label>
        <label>Distance to track (ft)
          <input type="number" value="${s.distanceToTrackFt}" data-action="rail-field" data-id="${s.id}" data-field="distanceToTrackFt" />
        </label>
        <label>Average Train Operations (ATO)
          <input type="number" value="${s.averageTrainOperations ?? ""}" data-action="rail-field" data-id="${s.id}" data-field="averageTrainOperations" />
        </label>
      </div>
      <button class="btn-primary" data-action="calc-rail" data-id="${s.id}">Calculate Rail #${s.id + 1} DNL</button>
      ${s.result ? `<table class="result-table"><tr><th>Rail DNL</th><td>${s.result.railDNL.toFixed(1)}</td></tr></table>` : ""}
    `;
    container.appendChild(card);
  });
}

// ---------- Site DNL + Summary ----------

function calcSite() {
  const roadDNLs = roadSources.filter((s) => s.result).map((s) => s.result.roadDNL);
  const railDNLs = railSources.filter((s) => s.result).map((s) => s.result.railDNL);

  if (roadDNLs.length === 0 && railDNLs.length === 0) {
    alert("Calculate at least one road or rail source first.");
    return;
  }

  const siteDNL = calcSiteDNL(roadDNLs, railDNLs);
  const status = siteDNL <= 65 ? "ok" : siteDNL <= 75 ? "warn" : "bad";
  const statusLabel = siteDNL <= 65 ? "Acceptable" : siteDNL <= 75 ? "Normally Unacceptable" : "Unacceptable";

  document.getElementById("site-result").innerHTML = `
    <div class="dnl-headline">${siteDNL.toFixed(1)} dB</div>
    <span class="dnl-status ${status}">${statusLabel}</span>
  `;

  const roadNames = roadSources.filter((s) => s.result).map((s) => s.roadName || "an unnamed road");
  const summary = generateSummary({
    siteDNL,
    roadNames,
    hasRail: railDNLs.length > 0,
  });
  document.getElementById("summary-output").value = summary;
}

// ---------- Event wiring ----------

document.getElementById("add-road-btn").addEventListener("click", addRoadSource);
document.getElementById("add-rail-btn").addEventListener("click", () => addRailSource());
document.getElementById("find-rail-btn").addEventListener("click", searchRail);
document.getElementById("calc-site-btn").addEventListener("click", calcSite);
document.getElementById("copy-summary-btn").addEventListener("click", () => {
  const output = document.getElementById("summary-output");
  output.select();
  document.execCommand("copy");
});

document.getElementById("road-panel").addEventListener("click", (e) => {
  const action = e.target.dataset.action;
  const id = parseInt(e.target.dataset.id, 10);
  if (action === "remove-road") removeRoad(id);
  if (action === "lookup-aadt") lookupAADTForRoad(id);
  if (action === "lookup-speed") lookupSpeedForRoad(id);
  if (action === "calc-road") calcRoad(id);
});

document.getElementById("road-panel").addEventListener("input", (e) => {
  const action = e.target.dataset.action;
  if (action === "field") {
    updateRoadField(parseInt(e.target.dataset.id, 10), e.target.dataset.field, e.target.value);
  }
});

document.getElementById("rail-panel").addEventListener("click", (e) => {
  const action = e.target.dataset.action;
  const id = parseInt(e.target.dataset.id, 10);
  if (action === "remove-rail") removeRail(id);
  if (action === "calc-rail") calcRail(id);
});

document.getElementById("rail-panel").addEventListener("input", (e) => {
  const action = e.target.dataset.action;
  if (action === "rail-field") {
    updateRailField(parseInt(e.target.dataset.id, 10), e.target.dataset.field, e.target.value);
  }
});

// Start with one road source ready to go
addRoadSource();
