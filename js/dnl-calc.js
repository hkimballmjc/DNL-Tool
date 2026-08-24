/**
 * HUD Day/Night Noise Level (DNL) Calculator — Core Math
 * ---------------------------------------------------------------
 * Implements the algorithm published by HUD's Office of Environment
 * and Energy in the "Day/Night Noise Level Assessment Tool Flowcharts"
 * (24 CFR Part 51 Subpart B), cross-referenced against 24 CFR 51.106.
 *
 * ⚠️ KNOWN OPEN ITEM (verify before relying on results):
 *   - Heavy truck EADT uses a factor from "Table 8" in HUD's Noise
 *     Assessment Guidelines Workbook, which is not reproduced in the
 *     published flowchart summary. Until that table is confirmed
 *     (e.g. by reverse-engineering a known result from the live HUD
 *     calculator), this code uses a PLACEHOLDER factor of 1.0
 *     (i.e., EADT_heavy = ADT_heavy). This is flagged in the UI.
 *   - Railway horns / bolted track adjustments are accepted as inputs
 *     but not yet applied (0 dB effect) pending the same confirmation
 *     process. Flag in UI.
 * ---------------------------------------------------------------
 */

const log10 = (x) => Math.log(x) / Math.LN10;

/** Combine any number of DNL values (in dB) using energy summation.
 *  This is the exact closed-form equivalent of HUD's "Table 1"
 *  decibel-combining lookup table. */
function combineDNL(levels) {
  const validLevels = levels.filter((l) => Number.isFinite(l));
  if (validLevels.length === 0) return null;
  const sumEnergy = validLevels.reduce((sum, L) => sum + Math.pow(10, L / 10), 0);
  return 10 * log10(sumEnergy);
}

/** Distance-to-stop-sign adjustment factor (cars & medium trucks). */
function dtsFactor(distanceToStopSignFt) {
  const dts = Math.min(Math.max(distanceToStopSignFt, 0), 600);
  return 0.1 + 0.9 * (dts / 600);
}

/**
 * Calculate DNL for a single vehicle type on a road source.
 * @param {"car"|"medium"|"heavy"} vehicleType
 * @param {number} speedMph - average speed for this vehicle type
 * @param {number} effectiveDistanceFt - distance from NAL to road
 * @param {number} adt - average daily traffic for this vehicle type
 * @param {number} nightFraction - default 0.15
 * @param {number} distanceToStopSignFt - 600 if none within 600ft
 * @param {number} roadGradientPercent - default 2
 */
function calcVehicleDNL({
  vehicleType,
  speedMph,
  effectiveDistanceFt,
  adt,
  nightFraction = 0.15,
  distanceToStopSignFt = 600,
  roadGradientPercent = 2,
}) {
  const S = speedMph;
  const D = effectiveDistanceFt;
  const n = nightFraction;
  const d = 1 - n;

  let AE;
  let EADT;
  const dts = dtsFactor(distanceToStopSignFt);

  if (vehicleType === "car") {
    AE = 64.6 + 20 * log10(S) - 15 * log10(D);
    EADT = adt * dts;
  } else if (vehicleType === "medium") {
    AE = 74.6 + 20 * log10(S) - 15 * log10(D);
    EADT = adt * 10 * dts;
  } else if (vehicleType === "heavy") {
    AE = S < 50 ? 114.5 - 15 * log10(D) : 80.5 + 20 * log10(S) - 15 * log10(D);
    // ⚠️ PLACEHOLDER — see file header. Table 8 factor not yet confirmed.
    const TABLE_8_FACTOR_PLACEHOLDER = 1.0;
    EADT = adt * TABLE_8_FACTOR_PLACEHOLDER;
  } else {
    throw new Error(`Unknown vehicle type: ${vehicleType}`);
  }

  let DNL = AE + 10 * log10(EADT * (d + 10 * n)) - 49.4;

  if (vehicleType === "heavy" && roadGradientPercent > 0) {
    const GAF = Math.pow(roadGradientPercent, 0.5);
    DNL += GAF;
  }

  return DNL;
}

/**
 * Calculate the combined Road DNL for one road source, given up to
 * three vehicle-type entries (car, medium, heavy).
 * @param {Array} vehicles - array of vehicle input objects (see calcVehicleDNL)
 * @param {object} roadInfo - { effectiveDistanceFt, distanceToStopSignFt, roadGradientPercent }
 */
function calcRoadDNL(vehicles, roadInfo) {
  const perVehicleDNL = vehicles.map((v) =>
    calcVehicleDNL({
      ...v,
      effectiveDistanceFt: roadInfo.effectiveDistanceFt,
      distanceToStopSignFt: roadInfo.distanceToStopSignFt,
      roadGradientPercent: roadInfo.roadGradientPercent,
    })
  );
  return {
    roadDNL: combineDNL(perVehicleDNL),
    perVehicleDNL: vehicles.map((v, i) => ({ type: v.vehicleType, dnl: perVehicleDNL[i] })),
  };
}

/** Derive ADT split for cars/medium/heavy trucks from a raw AADT figure,
 *  per the user's standard 3%/1% split. */
function splitAADT(aadt) {
  const mediumADT = aadt * 0.03;
  const heavyADT = aadt * 0.01;
  const carADT = aadt - mediumADT - heavyADT;
  return { carADT, mediumADT, heavyADT };
}

/**
 * Calculate DNL for a diesel or electric rail source.
 * @param {object} params
 */
function calcRailDNL({
  engineType, // "diesel" | "electric"
  engines,    // count of engines (default 2 diesel / 1 electric)
  cars,       // count of rail cars (default 50 diesel / 8 electric)
  speedMph = 30,
  distanceToTrackFt,
  averageTrainOperations, // ATO = yearly rail traffic / 365
  nightFractionATO = 0.15,
  railwayHorns = false, // ⚠️ not yet applied — see file header
  boltedTrack = false,  // ⚠️ not yet applied — see file header
}) {
  const S = speedMph;
  const Dl = distanceToTrackFt;
  const ATO = averageTrainOperations;
  const N = nightFractionATO;
  const D_pct = 1 - N;

  if (engineType === "electric") {
    const N2 = engines + cars; // electric engine counted as a rail car
    const AE = 71.4 + 20 * log10(S) + 10 * log10(N2) - 15 * log10(Dl);
    const AATOr = ATO * 100;
    const AATOtotal = AATOr + ATO * 4;
    const DNL = AE + 10 * log10(AATOtotal * (D_pct + 10 * N)) - 49.4;
    return { railDNL: DNL, components: { AE, N2, AATOtotal } };
  }

  if (engineType === "diesel") {
    // Engine sound source
    const AATOe = ATO * 10;
    const AEe = 141.7 - 10 * log10(S) + 10 * log10(AATOe) - 15 * log10(Dl);
    const DNLe = AEe + 10 * log10(AATOe * (D_pct + 10 * N)) - 49.4;

    // Rail car sound source
    const AATOc = ATO * 4;
    const AEc = 71.4 + 20 * log10(S) + 10 * log10(cars) - 15 * log10(Dl);
    const DNLc = AEc + 10 * log10(AATOc * (D_pct + 10 * N)) - 49.4;

    const railDNL = combineDNL([DNLe, DNLc]);
    return { railDNL, components: { DNLe, DNLc } };
  }

  throw new Error(`Unknown engine type: ${engineType}`);
}

/** Combine all road DNLs and rail DNLs into the overall Site DNL. */
function calcSiteDNL(roadDNLs, railDNLs) {
  return combineDNL([...roadDNLs, ...railDNLs]);
}

export {
  combineDNL,
  dtsFactor,
  calcVehicleDNL,
  calcRoadDNL,
  splitAADT,
  calcRailDNL,
  calcSiteDNL,
};
move to js folder
