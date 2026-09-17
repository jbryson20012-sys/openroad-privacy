const EARTH_RADIUS_M = 6_371_008.8;

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = "";
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (char === '"' && quoted && next === '"') {
      value += '"';
      i += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(value.trim());
      value = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") i += 1;
      row.push(value.trim());
      if (row.some((cell) => cell !== "")) rows.push(row);
      row = [];
      value = "";
    } else {
      value += char;
    }
  }

  row.push(value.trim());
  if (row.some((cell) => cell !== "")) rows.push(row);
  return rows;
}

function normalizedHeader(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

function firstValue(object, keys, fallback = "") {
  for (const key of keys) {
    if (object[key] !== undefined && object[key] !== null && object[key] !== "") return object[key];
  }
  return fallback;
}

export function normalizeBrand(value = "") {
  const brand = String(value).trim();
  if (!brand) return "Unknown ALPR";
  if (/flock/i.test(brand)) return "Flock Safety";
  return brand;
}

export function brandGroup(value = "") {
  const brand = normalizeBrand(value).toLowerCase();
  if (brand.includes("flock")) return "flock";
  if (brand.includes("unknown") || brand === "other") return "unknown";
  return "other";
}

export function normalizeCamera(input, index = 0) {
  const lat = Number(firstValue(input, ["lat", "latitude", "y"]));
  const lng = Number(firstValue(input, ["lng", "lon", "longitude", "x"]));
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return null;
  }
  const brand = normalizeBrand(firstValue(input, ["brand", "manufacturer", "operator", "type"], "Unknown ALPR"));
  const id = String(firstValue(input, ["id", "osm_id", "osmid"], `local-${Date.now()}-${index}`));
  return {
    id,
    lat,
    lng,
    brand,
    type: String(firstValue(input, ["type", "camera_type"], "ALPR")),
    direction: String(firstValue(input, ["direction", "bearing"], "")),
    confidence: String(firstValue(input, ["confidence", "status"], "unverified")).toLowerCase(),
    lastVerified: String(firstValue(input, ["last_verified", "lastverified", "observed", "date"], "")),
    sourceUrl: String(firstValue(input, ["source_url", "sourceurl", "url", "source"], "")),
    notes: String(firstValue(input, ["notes", "description"], "")),
    origin: String(firstValue(input, ["origin"], "local")),
  };
}

export function camerasFromCsv(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error("CSV needs a header row and at least one camera row.");
  const headers = rows[0].map(normalizedHeader);
  if (!headers.some((header) => ["lat", "latitude"].includes(header)) || !headers.some((header) => ["lng", "lon", "longitude"].includes(header))) {
    throw new Error("CSV must include latitude/lat and longitude/lng columns.");
  }
  return rows.slice(1)
    .map((cells, index) => Object.fromEntries(headers.map((header, column) => [header, cells[column] ?? ""])))
    .map((record, index) => normalizeCamera(record, index))
    .filter(Boolean);
}

export function camerasFromGeoJson(value) {
  const collection = typeof value === "string" ? JSON.parse(value) : value;
  const features = collection?.type === "FeatureCollection" ? collection.features : collection?.type === "Feature" ? [collection] : [];
  if (!Array.isArray(features)) throw new Error("GeoJSON must be a FeatureCollection of Point features.");
  return features.map((feature, index) => {
    if (feature?.geometry?.type !== "Point" || !Array.isArray(feature.geometry.coordinates)) return null;
    const [lng, lat] = feature.geometry.coordinates;
    return normalizeCamera({ ...feature.properties, id: feature.id ?? feature.properties?.id, lat, lng }, index);
  }).filter(Boolean);
}

export function toFeatureCollection(cameras) {
  return {
    type: "FeatureCollection",
    features: cameras.map((camera) => ({
      type: "Feature",
      id: camera.id,
      geometry: { type: "Point", coordinates: [camera.lng, camera.lat] },
      properties: {
        brand: camera.brand,
        type: camera.type,
        direction: camera.direction,
        confidence: camera.confidence,
        last_verified: camera.lastVerified,
        source_url: camera.sourceUrl,
        notes: camera.notes,
        origin: camera.origin,
      },
    })),
  };
}

export function mergeCameras(existing, incoming) {
  const result = [...existing];
  const keys = new Set(existing.map(cameraKey));
  for (const camera of incoming) {
    const key = cameraKey(camera);
    if (!keys.has(key)) {
      keys.add(key);
      result.push(camera);
    }
  }
  return result;
}

function cameraKey(camera) {
  const location = `${Number(camera.lat).toFixed(5)}:${Number(camera.lng).toFixed(5)}`;
  return `${location}:${normalizeBrand(camera.brand).toLowerCase()}`;
}

function radians(degrees) { return degrees * Math.PI / 180; }

export function haversineMeters(a, b) {
  const dLat = radians(b.lat - a.lat);
  const dLng = radians(b.lng - a.lng);
  const lat1 = radians(a.lat);
  const lat2 = radians(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function distancePointToSegmentMeters(point, start, end) {
  const referenceLat = radians((start.lat + end.lat + point.lat) / 3);
  const toXY = (coordinate) => ({
    x: radians(coordinate.lng - start.lng) * EARTH_RADIUS_M * Math.cos(referenceLat),
    y: radians(coordinate.lat - start.lat) * EARTH_RADIUS_M,
  });
  const p = toXY(point);
  const a = { x: 0, y: 0 };
  const b = toXY(end);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(p.x, p.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export function distancePointToPathMeters(point, path) {
  if (!path?.length) return Infinity;
  if (path.length === 1) return haversineMeters(point, path[0]);
  let minimum = Infinity;
  for (let i = 1; i < path.length; i += 1) {
    minimum = Math.min(minimum, distancePointToSegmentMeters(point, path[i - 1], path[i]));
  }
  return minimum;
}

export function camerasNearPath(cameras, path, thresholdMeters = 60) {
  return cameras
    .map((camera) => ({ ...camera, distanceToPathMeters: distancePointToPathMeters(camera, path) }))
    .filter((camera) => camera.distanceToPathMeters <= thresholdMeters)
    .sort((a, b) => a.distanceToPathMeters - b.distanceToPathMeters);
}

export function formatDistance(meters) {
  if (!Number.isFinite(meters)) return "—";
  const miles = meters / 1609.344;
  return miles < 10 ? `${miles.toFixed(1)} mi` : `${Math.round(miles)} mi`;
}

export function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds)) return "—";
  const minutes = Math.round(milliseconds / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours} hr ${remainder} min` : `${hours} hr`;
}

export function buildGoogleMapsUrl(origin, destination, path = []) {
  const url = new URL("https://www.google.com/maps/dir/");
  url.searchParams.set("api", "1");
  url.searchParams.set("origin", origin);
  url.searchParams.set("destination", destination);
  url.searchParams.set("travelmode", "driving");
  if (path.length >= 6) {
    const fractions = [0.25, 0.5, 0.75];
    const waypoints = fractions.map((fraction) => path[Math.min(path.length - 2, Math.max(1, Math.round((path.length - 1) * fraction)))])
      .map((point) => `${point.lat.toFixed(6)},${point.lng.toFixed(6)}`);
    url.searchParams.set("waypoints", waypoints.join("|"));
  }
  return url.toString();
}

export function escapeHtml(value = "") {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;",
  })[character]);
}
