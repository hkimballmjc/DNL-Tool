/**
 * Summary Paragraph Generator
 * ---------------------------------------------------------------
 * Produces a mitigant-style paragraph matching the format used in
 * Hannah's concept packages, e.g.:
 *
 *   "Mitigant: The Underwriter performed a preliminary noise model
 *   using HUD's online DNL calculator. Calculations can be found in
 *   Exhibit 5. The proposed multifamily site appears to be under/over
 *   the 65 dB "acceptable" threshold from noise emanating from
 *   [roads]. ..."
 * ---------------------------------------------------------------
 */

function formatRoadList(roadNames) {
  if (roadNames.length === 0) return "";
  if (roadNames.length === 1) return roadNames[0];
  if (roadNames.length === 2) return `${roadNames[0]} and ${roadNames[1]}`;
  return `${roadNames.slice(0, -1).join(", ")}, and ${roadNames[roadNames.length - 1]}`;
}

/**
 * @param {object} params
 * @param {number} params.siteDNL - final combined Site DNL
 * @param {string[]} params.roadNames - names of road sources included
 * @param {boolean} params.hasRail - whether a rail source was included
 * @param {object} [params.airportInfo] - optional { hasNearbyAirport, airports: [{name, distanceMiles}] }
 */
function generateSummary({ siteDNL, roadNames, hasRail, airportInfo }) {
  const roadList = formatRoadList(roadNames);
  const thresholdStatus =
    siteDNL <= 65
      ? `appears to be under the 65 dB "acceptable" threshold`
      : siteDNL <= 75
      ? `falls in the 65-75 dB "Normally Unacceptable" range, requiring additional sound attenuation`
      : `exceeds the 75 dB "Unacceptable" threshold`;

  let paragraph =
    `Mitigant: The Underwriter performed a preliminary noise model using HUD's online DNL ` +
    `calculator. Calculations can be found in Exhibit 5. The proposed multifamily site ${thresholdStatus} ` +
    `from noise emanating from ${roadList}` +
    (hasRail ? ` and nearby railroad activity` : ``) +
    `.`;

  if (airportInfo?.hasNearbyAirport) {
    const airportList = airportInfo.airports
      .map((a) => `${a.name} (${a.distanceMiles.toFixed(2)} miles)`)
      .join(", ");
    const plural = airportInfo.airports.length > 1 ? "airports" : "airport";
    paragraph +=
      ` The subject is within 15 miles of a civil or military airport. The civil ${plural} near the ` +
      `Subject ${airportInfo.airports.length > 1 ? "are" : "is"} ${airportList}. A Flight Noise Map ` +
      `concurred that the Subject is in less than a 50db zone, an acceptable Noise Zone in accordance ` +
      `to HUD. The map can be found in Exhibit 5.`;
  }

  paragraph +=
    ` A Phase I ESA and Part-50 HEROS assessment will be performed at the Pre-Application to mitigate ` +
    `all potential environmental risks.`;

  return paragraph;
}

export { generateSummary };
move to js folder
