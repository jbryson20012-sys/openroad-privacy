import test from "node:test";
import assert from "node:assert/strict";
import {
  buildGoogleMapsUrl,
  camerasFromCsv,
  camerasFromGeoJson,
  camerasNearPath,
  distancePointToSegmentMeters,
  mergeCameras,
  parseCsv,
} from "../core.js";
import { CameraPositionIndex } from "../camera-index.js";

test("CSV parser handles quoted commas and escaped quotes", () => {
  assert.deepEqual(parseCsv('id,notes\n1,"Near school, east side"\n2,"Says ""ALPR"""'), [
    ["id", "notes"],
    ["1", "Near school, east side"],
    ["2", 'Says "ALPR"'],
  ]);
});

test("CSV import normalizes coordinates and Flock brand", () => {
  const cameras = camerasFromCsv("latitude,longitude,manufacturer,confidence\n34.9,-85.2,Flock Falcon,confirmed");
  assert.equal(cameras.length, 1);
  assert.equal(cameras[0].brand, "Flock Safety");
  assert.equal(cameras[0].lat, 34.9);
});

test("GeoJSON import accepts Point features and skips other geometry", () => {
  const cameras = camerasFromGeoJson({
    type: "FeatureCollection",
    features: [
      { type: "Feature", geometry: { type: "Point", coordinates: [-85.2, 34.9] }, properties: { brand: "Other" } },
      { type: "Feature", geometry: { type: "LineString", coordinates: [] }, properties: {} },
    ],
  });
  assert.equal(cameras.length, 1);
});

test("camera merge removes same-brand points within coordinate precision", () => {
  const base = [{ id: "a", lat: 34.9, lng: -85.2, brand: "Flock Safety" }];
  const merged = mergeCameras(base, [
    { id: "b", lat: 34.900001, lng: -85.200001, brand: "Flock Safety" },
    { id: "c", lat: 34.91, lng: -85.21, brand: "Flock Safety" },
  ]);
  assert.equal(merged.length, 2);
});

test("point-to-segment distance and path corridor are geographically plausible", () => {
  const path = [{ lat: 35, lng: -85 }, { lat: 35, lng: -84.99 }];
  const near = { id: "near", lat: 35.0002, lng: -84.995, brand: "Flock Safety" };
  const far = { id: "far", lat: 35.01, lng: -84.995, brand: "Other" };
  assert.ok(distancePointToSegmentMeters(near, path[0], path[1]) < 30);
  assert.deepEqual(camerasNearPath([near, far], path, 60).map((camera) => camera.id), ["near"]);
});

test("Google Maps URL includes route-shaping waypoints", () => {
  const path = Array.from({ length: 9 }, (_, index) => ({ lat: 35 + index / 100, lng: -85 + index / 100 }));
  const url = new URL(buildGoogleMapsUrl("A", "B", path));
  assert.equal(url.searchParams.get("origin"), "A");
  assert.equal(url.searchParams.get("destination"), "B");
  assert.equal(url.searchParams.get("waypoints").split("|").length, 3);
});

test("binary camera index validates, queries, and scores a route", () => {
  const points = [
    { lat: 35, lng: -85, brand: 1 },
    { lat: 35.01, lng: -85.01, brand: 2 },
  ];
  const buffer = new ArrayBuffer(16 + points.length * 9);
  const view = new DataView(buffer);
  new Uint8Array(buffer, 0, 4).set([..."FHIX"].map((character) => character.charCodeAt(0)));
  view.setUint32(4, 1, true);
  view.setUint32(8, points.length, true);
  const latitudes = new Int32Array(buffer, 16, points.length);
  const longitudes = new Int32Array(buffer, 16 + points.length * 4, points.length);
  const brands = new Uint8Array(buffer, 16 + points.length * 8, points.length);
  points.forEach((point, index) => {
    latitudes[index] = Math.round(point.lat * 1e6);
    longitudes[index] = Math.round(point.lng * 1e6);
    brands[index] = point.brand;
  });
  const index = new CameraPositionIndex(buffer, { count: 2, brands: ["unknown", "Flock Safety", "Other"] });
  assert.equal(index.queryBounds({ south: 34.99, west: -85.02, north: 35.02, east: -84.99 }).length, 2);
  const matches = index.findNearPath([{ lat: 35, lng: -85.005 }, { lat: 35, lng: -84.995 }], 70);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].brand, "Flock Safety");
});
