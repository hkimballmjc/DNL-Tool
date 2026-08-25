import { calcRoadDNL, calcRailDNL, calcSiteDNL, splitAADT } from "./js/dnl-calc.js";
import { STATE_ENDPOINTS, TX_SPEED_LIMITS_URL } from "./js/aadt-lookup.js";
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

// ---------- Parcel boundaries (nationwide, free, no login required) ----------

const PARCEL_LAYER_URL =
  "https://tiles.arcgis.com/tiles/KzeiCaQsMoeCfoCq/arcgis/rest/services/Regrid_Nationwide_Parcel_Boundaries_v1/MapServer";
let parcelLayer = null;
let parcelsVisible = false;

function toggleParcels() {
  parcelsVisible = !parcelsVisible;
  const btn = document.getElementById("parcels-btn");
  if (parcelsVisible) {
    parcelLayer = L.esri.tiledMapLayer({ url: PARCEL_LAYER_URL }).addTo(map);
    btn.textContent = "Hide parcel boundaries";
    btn.classList.add("btn-primary");
  } else {
    if (parcelLayer) map.removeLayer(parcelLayer);
    parcelLayer = null;
    btn.textContent = "Show parcel boundaries";
    btn.classList.remove("btn-primary");
  }
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
      style: () => ({ color: "#2f6b4f", weight: 3, opacity: 0.55 }),
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

/** Manual AADT entry -- typing a number here does the 3%/1% split
 * math instantly. Find the number by clicking the road on the map above,
 * then type it in here. */
function setManualAADT(id, value) {
  const s = roadSources.find((r) => r.id === id);
  const num = parseFloat(value);
  if (!Number.isFinite(num) || num <= 0) return;
  s.aadt = num;
  applyAADTSplit(id);
}

/** Manual speed entry -- typing a value applies it to all three
 * vehicle types with the medium/heavy -5mph rule applied automatically.
 * Find the number by clicking the road on the map above. */
function setManualSpeed(id, value) {
  const s = roadSources.find((r) => r.id === id);
  const num = parseFloat(value);
  if (!Number.isFinite(num) || num <= 0) return;
  applySpeedToRoad(s, num);
}

function applySpeedToRoad(s, speedMph) {
  s.vehicles.car.speed = speedMph;
  s.vehicles.medium.speed = Math.max(speedMph - 5, 0);
  s.vehicles.heavy.speed = Math.max(speedMph - 5, 0);
  renderRoadList();
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
  if (!(s.effectiveDistanceFt > 0)) {
    alert("Effective distance must be greater than 0 ft.");
    return;
  }
  const zeroSpeedVehicle = vehicles.find((v) => !(v.speedMph > 0));
  if (zeroSpeedVehicle) {
    alert(`Speed for ${zeroSpeedVehicle.vehicleType} must be greater than 0 mph.`);
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
        <label class="field-wide">Road name
          <input type="text" value="${s.roadName}" data-action="field" data-id="${s.id}" data-field="roadName" />
        </label>
        <label class="field-narrow">Effective distance (ft)
          <input type="number" value="${s.effectiveDistanceFt}" data-action="field" data-id="${s.id}" data-field="effectiveDistanceFt" />
        </label>
        <label class="field-narrow">Distance to stop sign (ft, 600 = none)
          <input type="number" value="${s.distanceToStopSignFt}" data-action="field" data-id="${s.id}" data-field="distanceToStopSignFt" />
        </label>
        <label class="field-narrow">Road gradient (%)
          <input type="number" value="${s.roadGradientPercent}" data-action="field" data-id="${s.id}" data-field="roadGradientPercent" />
        </label>
      </div>
      <div class="field-row">
        <label>AADT (car/medium/heavy split calculated automatically)
          <input type="number" placeholder="e.g. 16499" value="${s.aadt ?? ""}" data-action="manual-aadt" data-id="${s.id}" />
        </label>
        <label>Speed limit, mph (medium/heavy set to -5 automatically)
          <input type="number" placeholder="e.g. 40" data-action="manual-speed" data-id="${s.id}" />
        </label>
      </div>
      <p class="hint">Click the road on the map above to find its AADT and speed limit, then type the numbers in here.</p>
      <div class="vehicle-row head"><div>Type</div><div>Speed (mph)</div><div>ADT</div></div>
      ${["car", "medium", "heavy"]
        .map(
          (type) => `
        <div class="vehicle-row">
          <div>${type}</div>
          <input type="number" value="${s.vehicles[type].speed}" data-action="field" data-id="${s.id}" data-field="vehicle.${type}.speed" />
          <input type="number" value="${s.vehicles[type].adt}" data-action="field" data-id="${s.id}" data-field="vehicle.${type}.adt" />
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
              ${s.result.perVehicleDNL.map((v) => `<tr><td>${v.type}</td><td>${Number.isFinite(v.dnl) ? Math.round(v.dnl) : "N/A -- check inputs (0 or blank speed/ADT?)"}</td></tr>`).join("")}
              <tr><th>Road DNL</th><th>${Number.isFinite(s.result.roadDNL) ? Math.round(s.result.roadDNL) : "N/A -- check inputs (0 or blank speed/ADT?)"}</th></tr>
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
      ${s.result ? `<table class="result-table"><tr><th>Rail DNL</th><td>${Math.round(s.result.railDNL)}</td></tr></table>` : ""}
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
    <div class="dnl-headline">${Math.round(siteDNL)} dB</div>
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
  if (action === "calc-road") calcRoad(id);
});

document.getElementById("road-panel").addEventListener("input", (e) => {
  const action = e.target.dataset.action;
  if (action === "field") {
    updateRoadField(parseInt(e.target.dataset.id, 10), e.target.dataset.field, e.target.value);
  }
});

// Manual AADT/speed entry uses "change" (fires on blur or Enter) rather
// than "input" (fires every keystroke) -- otherwise the re-render below
// would rebuild the input field mid-type and kick you out of it.
document.getElementById("road-panel").addEventListener("change", (e) => {
  const action = e.target.dataset.action;
  const id = parseInt(e.target.dataset.id, 10);
  if (action === "manual-aadt") setManualAADT(id, e.target.value);
  if (action === "manual-speed") setManualSpeed(id, e.target.value);
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

document.getElementById("show-map-btn").addEventListener("click", showOnMap);
document.getElementById("parcels-btn").addEventListener("click", toggleParcels);
document.getElementById("measure-btn").addEventListener("click", toggleMeasure);
document.getElementById("clear-measure-btn").addEventListener("click", clearMeasurement);

// Start with one road source ready to go
addRoadSource();
initMap();
