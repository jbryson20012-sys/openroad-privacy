import { distancePointToSegmentMeters } from "./core.js";

const HEADER_BYTES = 16;
const MICRODEGREES = 1_000_000;

export class CameraPositionIndex {
  constructor(buffer, metadata, cellSizeDegrees = 0.05) {
    this.buffer = buffer;
    this.metadata = metadata;
    this.cellSize = cellSizeDegrees;
    this.grid = new Map();
    this.#parse();
    this.#buildGrid();
  }

  static async load({ binaryUrl, metadataUrl, fetchImpl = fetch }) {
    const [binaryResponse, metadataResponse] = await Promise.all([
      fetchImpl(binaryUrl, { cache: "no-cache" }),
      fetchImpl(metadataUrl, { cache: "no-cache" }),
    ]);
    if (!binaryResponse.ok) throw new Error(`Camera index request failed (${binaryResponse.status}).`);
    if (!metadataResponse.ok) throw new Error(`Camera metadata request failed (${metadataResponse.status}).`);
    const [buffer, metadata] = await Promise.all([binaryResponse.arrayBuffer(), metadataResponse.json()]);
    return new CameraPositionIndex(buffer, metadata);
  }

  #parse() {
    if (!(this.buffer instanceof ArrayBuffer) || this.buffer.byteLength < HEADER_BYTES) throw new Error("Camera index is too small.");
    const view = new DataView(this.buffer);
    const magic = String.fromCharCode(...new Uint8Array(this.buffer, 0, 4));
    const version = view.getUint32(4, true);
    const count = view.getUint32(8, true);
    const expectedLength = HEADER_BYTES + count * 9;
    if (magic !== "FHIX") throw new Error("Camera index has an invalid header.");
    if (version !== 1) throw new Error(`Unsupported camera index version: ${version}.`);
    if (this.buffer.byteLength !== expectedLength) throw new Error("Camera index length does not match its header.");
    if (this.metadata?.count !== undefined && Number(this.metadata.count) !== count) throw new Error("Camera index and metadata counts differ.");
    this.version = version;
    this.count = count;
    this.latitudes = new Int32Array(this.buffer, HEADER_BYTES, count);
    this.longitudes = new Int32Array(this.buffer, HEADER_BYTES + count * 4, count);
    this.brandIds = new Uint8Array(this.buffer, HEADER_BYTES + count * 8, count);
    this.brands = Array.isArray(this.metadata?.brands) ? this.metadata.brands : ["Unknown ALPR"];
  }

  #cellKey(lat, lng) {
    return `${Math.floor((lat + 90) / this.cellSize)}:${Math.floor((lng + 180) / this.cellSize)}`;
  }

  #buildGrid() {
    for (let index = 0; index < this.count; index += 1) {
      const lat = this.latitudes[index] / MICRODEGREES;
      const lng = this.longitudes[index] / MICRODEGREES;
      const key = this.#cellKey(lat, lng);
      const bucket = this.grid.get(key);
      if (bucket) bucket.push(index);
      else this.grid.set(key, [index]);
    }
  }

  get(index) {
    if (index < 0 || index >= this.count) return null;
    const brandId = this.brandIds[index];
    return {
      id: `deflock-${index}`,
      index,
      lat: this.latitudes[index] / MICRODEGREES,
      lng: this.longitudes[index] / MICRODEGREES,
      brand: this.brands[brandId] || "Unknown ALPR",
      brandId,
      origin: "deflock-osm",
      confidence: "community",
    };
  }

  queryBounds({ south, west, north, east }, limit = Infinity) {
    const matches = [];
    const latStart = Math.floor((Math.max(-90, south) + 90) / this.cellSize);
    const latEnd = Math.floor((Math.min(90, north) + 90) / this.cellSize);
    const ranges = west <= east ? [[west, east]] : [[west, 180], [-180, east]];
    for (const [rangeWest, rangeEast] of ranges) {
      const lngStart = Math.floor((Math.max(-180, rangeWest) + 180) / this.cellSize);
      const lngEnd = Math.floor((Math.min(180, rangeEast) + 180) / this.cellSize);
      for (let latCell = latStart; latCell <= latEnd; latCell += 1) {
        for (let lngCell = lngStart; lngCell <= lngEnd; lngCell += 1) {
          const bucket = this.grid.get(`${latCell}:${lngCell}`) || [];
          for (const index of bucket) {
            const lat = this.latitudes[index] / MICRODEGREES;
            const lng = this.longitudes[index] / MICRODEGREES;
            if (lat >= south && lat <= north && inLongitudeRange(lng, west, east)) {
              matches.push(index);
              if (matches.length >= limit) return matches;
            }
          }
        }
      }
    }
    return matches;
  }

  findNearPath(path, thresholdMeters = 60) {
    if (!Array.isArray(path) || path.length < 2) return [];
    const candidates = new Set();
    for (let segment = 1; segment < path.length; segment += 1) {
      const start = path[segment - 1];
      const end = path[segment];
      const latPadding = thresholdMeters / 110_574;
      const meanLat = (start.lat + end.lat) / 2;
      const lngPadding = thresholdMeters / Math.max(20_000, 111_320 * Math.cos(meanLat * Math.PI / 180));
      const bounds = {
        south: Math.min(start.lat, end.lat) - latPadding,
        north: Math.max(start.lat, end.lat) + latPadding,
        west: Math.min(start.lng, end.lng) - lngPadding,
        east: Math.max(start.lng, end.lng) + lngPadding,
      };
      for (const index of this.queryBounds(bounds)) candidates.add(index);
    }

    const matches = [];
    for (const index of candidates) {
      const camera = this.get(index);
      let minimum = Infinity;
      for (let segment = 1; segment < path.length; segment += 1) {
        minimum = Math.min(minimum, distancePointToSegmentMeters(camera, path[segment - 1], path[segment]));
        if (minimum <= thresholdMeters) break;
      }
      if (minimum <= thresholdMeters) matches.push({ ...camera, distanceToPathMeters: minimum });
    }
    return matches.sort((a, b) => a.distanceToPathMeters - b.distanceToPathMeters);
  }
}

function inLongitudeRange(lng, west, east) {
  return west <= east ? lng >= west && lng <= east : lng >= west || lng <= east;
}
