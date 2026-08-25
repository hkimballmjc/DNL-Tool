import { calcRoadDNL, calcRailDNL, calcSiteDNL, splitAADT } from "./js/dnl-calc.js";
import { STATE_ENDPOINTS, TX_SPEED_LIMITS_URL, TN_SPEED_LIMITS_URL } from "./js/aadt-lookup.js";
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
    parcelLayer = L.esri.tiledMapLayer({ url: PARCEL_LAYER_URL, maxNativeZoom: 17, maxZoom: 22 }).addTo(map);
    btn.textContent = "Hide parcel boundaries";
    btn.classList.add("btn-primary");
  } else {
    if (parcelLayer) map.removeLayer(parcelLayer);
    parcelLayer = null;
    btn.textContent = "Show parcel boundaries";
    btn.classList.remove("btn-primary");
  }
}

// ---------- Export Report (matches HUD calculator's own format) ----------

function generateReport() {
  const siteName = document.getElementById("site-name").value || "(unnamed site)";
  const userName = document.getElementById("export-username").value || "";
  const recordDate = document.getElementById("export-date").value || "";

  const roadDNLs = roadSources.filter((s) => s.result).map((s) => s.result.roadDNL);
  const railDNLs = railSources.filter((s) => s.result).map((s) => s.result.railDNL);
  const combinedDNL = roadDNLs.length || railDNLs.length ? Math.round(calcSiteDNL(roadDNLs, railDNLs)) : null;

  let html = `
    <h3 class="report-title">Day/Night Noise Level (DNL) Calculator</h3>
    <table class="report-header-table">
      <tr><td>Site ID</td><td>${siteName}</td></tr>
      <tr><td>Record Date</td><td>${recordDate || "(not set)"}</td></tr>
      <tr><td>User's Name</td><td>${userName || "(not set)"}</td></tr>
    </table>
    <div class="report-combined">Combined DNL for all Road and Rail sources: <strong>${combinedDNL ?? "(calculate at least one source first)"}</strong></div>
  `;

  roadSources.forEach((s, i) => {
    html += `<div class="report-source-header">Road # ${i + 1} Name: <strong>${s.roadName || "(unnamed)"}</strong></div>`;
    if (!s.result) {
      html += `<p class="report-note">Not yet calculated.</p>`;
      return;
    }
    const dnlByType = Object.fromEntries(s.result.perVehicleDNL.map((v) => [v.type, v.dnl]));
    html += `
      <table class="report-table">
        <tr><th>Vehicle Type</th><th>Cars</th><th>Medium Trucks</th><th>Heavy Trucks</th></tr>
        <tr><td>Effective Distance</td><td>${s.effectiveDistanceFt ?? ""}</td><td>${s.effectiveDistanceFt ?? ""}</td><td>${s.effectiveDistanceFt ?? ""}</td></tr>
        <tr><td>Distance to Stop Sign</td><td>${s.distanceToStopSignFt ?? ""}</td><td>${s.distanceToStopSignFt ?? ""}</td><td>${s.distanceToStopSignFt ?? ""}</td></tr>
        <tr><td>Average Speed</td><td>${s.vehicles.car.speed}</td><td>${s.vehicles.medium.speed}</td><td>${s.vehicles.heavy.speed}</td></tr>
        <tr><td>Average Daily Trips (ADT)</td><td>${s.vehicles.car.adt}</td><td>${s.vehicles.medium.adt}</td><td>${s.vehicles.heavy.adt}</td></tr>
        <tr><td>Night Fraction of ADT</td><td>15</td><td>15</td><td>15</td></tr>
        <tr><td>Road Gradient (%)</td><td></td><td></td><td>2</td></tr>
        <tr><td>Vehicle DNL</td><td>${Number.isFinite(dnlByType.car) ? Math.round(dnlByType.car) : ""}</td><td>${Number.isFinite(dnlByType.medium) ? Math.round(dnlByType.medium) : ""}</td><td>${Number.isFinite(dnlByType.heavy) ? Math.round(dnlByType.heavy) : ""}</td></tr>
      </table>
      <div class="report-source-total">Road #${i + 1} DNL: <strong>${Number.isFinite(s.result.roadDNL) ? Math.round(s.result.roadDNL) : "N/A"}</strong></div>
    `;
  });

  railSources.forEach((s, i) => {
    const isElectric = s.engineType === "electric";
    html += `<div class="report-source-header">Rail # ${i + 1}: <strong>${s.trackIdentifier || "(unnamed)"}</strong> (${s.engineType})</div>`;
    if (!s.result) {
      html += `<p class="report-note">Not yet calculated.</p>`;
      return;
    }
    html += `
      <table class="report-table">
        <tr><td>Effective Distance (to track)</td><td>${s.distanceToTrackFt}</td></tr>
        <tr><td>Average Speed</td><td>30</td></tr>
        <tr><td>Engines per Train</td><td>${isElectric ? 1 : 2}</td></tr>
        <tr><td>Rail Cars per Train</td><td>${isElectric ? 8 : 50}</td></tr>
        <tr><td>Average Train Operations (ATO)</td><td>${s.averageTrainOperations}</td></tr>
        <tr><td>Night Fraction of ATO</td><td>15</td></tr>
      </table>
      <div class="report-source-total">Rail #${i + 1} DNL: <strong>${Math.round(s.result.railDNL)}</strong></div>
    `;
  });

  document.getElementById("report-preview").innerHTML = html;
  document.getElementById("print-report-btn").style.display = "inline-block";
}

function printReport() {
  window.print();
}

// ---------- Speed limit road layer (persistent, visible while panning) ----------

let speedLayer = null;

function addSpeedLayer(state) {
  if (speedLayer) {
    map.removeLayer(speedLayer);
    speedLayer = null;
  }
  if (!window.L.esri) return;

  if (state === "TX") {
    speedLayer = L.esri
      .featureLayer({
        url: TX_SPEED_LIMITS_URL,
        where: "SPD_LMT IS NOT NULL",
        style: () => ({ color: "#2f6b4f", weight: 6, opacity: 0.6 }),
      })
      .bindPopup((layer) => {
        const a = layer.feature.properties;
        const buildContent = (streetName) => {
          const label = streetName ? `Road: ${streetName}` : [a.RTE_PRFX, a.RTE_NBR, a.RTE_SFX].filter(Boolean).join(" ") || a.RTE_NM || "(unnamed route)";
          return `${label}<br>Speed limit: ${a.SPD_LMT} mph<br><span style="font-size:11px;color:#6b7c94;">Data extracted: ${a.EXT_DATE || "unknown"}</span>`;
        };
        attachStreetNameLookup(layer, buildContent);
        return buildContent(null);
      })
      .addTo(map);
  } else if (state === "TN") {
    speedLayer = L.esri
      .featureLayer({
        url: TN_SPEED_LIMITS_URL,
        where: "SPD_LMT IS NOT NULL",
        style: () => ({ color: "#2f6b4f", weight: 6, opacity: 0.6 }),
      })
      .bindPopup((layer) => {
        const a = layer.feature.properties;
        const buildContent = (streetName) => {
          const label = streetName ? `Road: ${streetName}` : [a.NBR_TENN_CNTY, a.NBR_RTE].filter(Boolean).join(" - ") || "(unnamed route)";
          return `${label}<br>Speed limit: ${a.SPD_LMT} mph<br><span style="font-size:11px;color:#6b7c94;">Source dataset last updated April 2026 (no per-segment date available)</span>`;
        };
        attachStreetNameLookup(layer, buildContent);
        return buildContent(null);
      })
      .addTo(map);
  }
  // OK: no confirmed speed dataset yet
}

// ---------- Embedded map ----------

/**
 * Looks up the real street name for a location via OpenStreetMap's
 * reverse geocoder. Only called when a popup is actually opened (one
 * request per click), not for every rendered marker -- that keeps
 * usage well within Nominatim's fair-use limits.
 */
async function fetchStreetName(lat, lng) {
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=17&addressdetails=1`
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data.address?.road || null;
  } catch {
    return null;
  }
}

/** Gets a representative lat/lng from a layer regardless of whether it's
 * a point marker (has getLatLng) or a line/polygon feature (does not --
 * needs its vertex list or bounds center instead). */
function getRepresentativePoint(layer) {
  if (typeof layer.getLatLng === "function") return layer.getLatLng();
  if (typeof layer.getLatLngs === "function") {
    const latlngs = layer.getLatLngs();
    const flat = Array.isArray(latlngs[0]) ? latlngs.flat(Infinity) : latlngs;
    if (flat.length) return flat[Math.floor(flat.length / 2)];
  }
  if (typeof layer.getBounds === "function") return layer.getBounds().getCenter();
  return null;
}

/** Attaches a one-time street-name lookup to a marker/layer's popup --
 * fires on first open, replacing the fallback route-code content with
 * the real street name if OpenStreetMap has one for that location. */
function attachStreetNameLookup(layer, buildContent) {
  let resolved = false;
  layer.on("popupopen", async () => {
    if (resolved) return;
    resolved = true;
    const point = getRepresentativePoint(layer);
    if (!point) return;
    const name = await fetchStreetName(point.lat, point.lng);
    if (name) layer.setPopupContent(buildContent(name));
  });
}

/**
 * Renders AADT as small dots, matching Texas's pin style, regardless of
 * whether the state's underlying data is points (TX) or line segments
 * (TN). Drawing TN's line segments directly produced thick, overlapping
 * "ribbon" bands at interchanges (many short adjoining segments with
 * semi-transparent strokes stacking up) -- a dot at each segment's
 * midpoint gives the same clickable information without that clutter.
 */
function buildAADTLayer(config, state) {
  const group = L.layerGroup();
  const nameLabel = state === "OK" || state === "TN" ? "Route code" : "Road";
  const AADT_COLOR = "#3f5fa8";

  const popupFor = (a, streetName) => {
    const label = streetName ? `Road: ${streetName}` : `${nameLabel}: ${a[config.fieldMap.roadName] || "(unnamed)"}`;
    const detailLink = config.fieldMap.detailLink && a[config.fieldMap.detailLink]
      ? `<br><a href="${a[config.fieldMap.detailLink]}" target="_blank" rel="noopener">View official record</a>`
      : "";
    return `${label}<br>AADT: ${a[config.fieldMap.aadt]} (${a[config.fieldMap.year]})${detailLink}`;
  };

  const esriLayer = L.esri.featureLayer({
    url: config.featureServerUrl,
    style: () => ({ opacity: 0, fillOpacity: 0, weight: 0, interactive: false }), // hidden AND non-clickable, so it can't steal clicks from the dot on top
    pointToLayer: (geojson, latlng) => {
      const marker = L.circleMarker(latlng, { radius: 9, color: AADT_COLOR, weight: 2, fillColor: AADT_COLOR, fillOpacity: 0.8 })
        .bindPopup(popupFor(geojson.properties));
      attachStreetNameLookup(marker, (name) => popupFor(geojson.properties, name));
      return marker;
    },
    onEachFeature: (geojson, lyr) => {
      const geomType = geojson.geometry && geojson.geometry.type;
      if (geomType === "LineString" || geomType === "MultiLineString") {
        const coords = geomType === "LineString" ? geojson.geometry.coordinates : geojson.geometry.coordinates[0];
        if (coords && coords.length) {
          const mid = coords[Math.floor(coords.length / 2)];
          const marker = L.circleMarker([mid[1], mid[0]], { radius: 9, color: AADT_COLOR, weight: 2, fillColor: AADT_COLOR, fillOpacity: 0.8 })
            .bindPopup(popupFor(geojson.properties))
            .addTo(group);
          attachStreetNameLookup(marker, (name) => popupFor(geojson.properties, name));
        }
      }
      // Point features are already handled by pointToLayer above.
    },
  });

  group.addLayer(esriLayer);
  return group;
}

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

  // Speed layer first, then AADT -- AADT renders on top so its dots
  // stay easily clickable instead of a speed line passing over them
  // and intercepting the click.
  addSpeedLayer(state);

  if (aadtLayer) {
    map.removeLayer(aadtLayer);
    aadtLayer = null;
  }
  const config = STATE_ENDPOINTS[state];
  const legend = document.getElementById("map-legend");
  if (config && !config.featureServerUrl.startsWith("REPLACE_WITH") && window.L.esri) {
    aadtLayer = buildAADTLayer(config, state).addTo(map);
    legend.style.display = "block";
  } else {
    legend.style.display = "none";
  }
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
    effectiveDistanceFt: null,
    distanceToStopSignFt: null,
    aadt: null,
    speedLimitInput: null,
    vehicles: { car: { speed: 0, adt: 0 }, medium: { speed: 0, adt: 0 }, heavy: { speed: 0, adt: 0 } },
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
  } else if (field === "roadName") {
    s[field] = value;
  } else if (field === "distanceToStopSignFt") {
    // Blank means "600ft or more / no stop sign nearby" -- the formula's
    // own way of saying "no reduction applies" -- not 0, which would mean
    // the opposite (a stop sign right at the boundary).
    s[field] = value.trim() === "" ? null : parseFloat(value);
  } else {
    s[field] = parseFloat(value) || 0;
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
  s.speedLimitInput = num;
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
    distanceToStopSignFt: s.distanceToStopSignFt ?? 600,
    roadGradientPercent: 2, // HUD standard assumption -- see note in Road Sources panel
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
          <input type="number" value="${s.effectiveDistanceFt ?? ""}" data-action="field" data-id="${s.id}" data-field="effectiveDistanceFt" />
        </label>
        <label class="field-narrow">Distance to stop sign (ft) if &lt;600
          <input type="number" value="${s.distanceToStopSignFt ?? ""}" data-action="field" data-id="${s.id}" data-field="distanceToStopSignFt" />
        </label>
      </div>
      <p class="hint">Click the road on the map above to find its AADT and speed limit, then type the numbers in below -- car/medium/heavy split out automatically.</p>
      <div class="vehicle-row head"><div>Type</div><div>Speed (mph)</div><div>ADT</div></div>
      <div class="vehicle-row">
        <div>Overall</div>
        <input type="number" placeholder="e.g. 40" value="${s.speedLimitInput ?? ""}" data-action="manual-speed" data-id="${s.id}" />
        <input type="number" placeholder="e.g. 16499" value="${s.aadt ?? ""}" data-action="manual-aadt" data-id="${s.id}" />
      </div>
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
  const displayDNL = Math.round(siteDNL);
  const status = displayDNL <= 65 ? "ok" : displayDNL <= 75 ? "warn" : "bad";
  const statusLabel = displayDNL <= 65 ? "Acceptable" : displayDNL <= 75 ? "Normally Unacceptable" : "Unacceptable";

  document.getElementById("site-result").innerHTML = `
    <div class="dnl-headline">${displayDNL} dB</div>
    <span class="dnl-status ${status}">${statusLabel}</span>
  `;

  const roadNames = roadSources.filter((s) => s.result).map((s) => s.roadName || "an unnamed road");
  const summary = generateSummary({
    siteDNL: displayDNL,
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
document.getElementById("generate-report-btn").addEventListener("click", generateReport);
document.getElementById("print-report-btn").addEventListener("click", printReport);

// Default the record date to today
document.getElementById("export-date").value = new Date().toISOString().split("T")[0];

// Start with one road source ready to go
addRoadSource();
initMap();
