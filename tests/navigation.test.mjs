import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import * as core from '../core.js';

// Exercise the real event handlers with controlled GPS, map, and routing adapters.
const source = (await readFile(new URL('../app.js', import.meta.url), 'utf8'))
  .replace(/^import[\s\S]*?from [^;]+;\s*/gm, '');
function app() {
  const nodes = new Map();
  function node(id) {
    if (nodes.has(id)) return nodes.get(id);
    const classes = new Set();
    const value = { value: '', textContent: '', hidden: false, checked: false,
      lastChild: {}, events: {}, attributes: {},
      classList: { add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c), toggle(c, on) { if (on) classes.add(c); else classes.delete(c); } },
      addEventListener(type, handler) { this.events[type] = handler; },
      setAttribute(key, val) { this.attributes[key] = val; },
      querySelector(s) { return node(id + s); }, querySelectorAll() { return []; },
      focus() {}, contains() { return false; }, scrollIntoView() {},
      showModal() { this.open = true; }, close() { this.open = false; }, reset() {},
    };
    nodes.set(id, value); return value;
  }
  node('origin').value = 'My location';
  node('alert-distance').value = '305';
  const map = { pans: [], zoom: 12, handlers: {},
    setView() { return this; }, on(e, cb) { this.handlers[e] = cb; },
    panTo(p) { this.pans.push(p); }, setZoom(z) { this.zoom = z; }, getZoom() { return this.zoom; },
    getBounds() { return { getSouth: () => 34, getNorth: () => 36, getWest: () => -86, getEast: () => -84, contains: () => true }; },
  };
  const location = { timestamp: Date.now(), coords: { latitude: 35, longitude: -85, accuracy: 5, heading: 0, speed: 10 } };
  const gps = { cleared: null, getCurrentPosition(ok) { ok(location); }, watchPosition(ok) { this.update = ok; return 7; }, clearWatch(id) { this.cleared = id; } };
  const L = { map: () => map, control: { zoom: () => ({ addTo() {} }) }, tileLayer: () => ({ addTo() {} }),
    layerGroup: () => ({ addTo() { return this; }, clearLayers() {} }), divIcon: options => options,
    marker: (position, options) => ({ position, options, addTo() { return this; }, setLatLng(p) { this.position = p; return this; }, setIcon(i) { this.options.icon = i; return this; }, remove() {} }),
  };
  const context = vm.createContext({ ...core, L, console: { warn() {}, error() {} },
    CameraPositionIndex: { load: () => new Promise(() => {}) },
    document: { getElementById: node, querySelectorAll: () => [], addEventListener() {}, readyState: 'complete' },
    window: { L, innerWidth: 390, addEventListener() {} }, navigator: { geolocation: gps },
    localStorage: { getItem: () => null }, location: { protocol: 'https:' },
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 2, clearInterval() {},
  });
  vm.runInContext(source + '\nthis.subject = { state, useCurrentLocation, recenterMap, handleRouteSubmit, toggleDriving, updateDrivingPosition, stopDriving, beginReport, selectReportLocation };', context);
  return { ...context.subject, node, map, gps, location };
}

test('current location stays human-readable, survives swapping, and yields to typed addresses', async () => {
  const a = app();
  await a.useCurrentLocation();
  assert.equal(a.node('origin').value, 'My location');
  a.node('destination').value = 'Chattanooga, TN';
  a.node('swap-button').events.click();
  assert.equal(a.node('destination').value, 'My location');
  assert.equal(a.state.endpoints.destination, 'current');
  a.node('destination').value = 'Atlanta, GA';
  a.node('destination').events.input();
  assert.equal(a.state.endpoints.destination, 'address');
  await a.recenterMap();
  assert.equal(a.node('origin').value, 'Chattanooga, TN');
  assert.equal(a.node('destination').value, 'Atlanta, GA');
});

test('routing sends GPS coordinates internally, including when My location is the destination', async () => {
  const a = app();
  a.state.cameraIndex = {};
  let request;
  a.state.routeClass = { async computeRoutes(value) { request = value; return { routes: [] }; } };
  a.node('destination').value = 'Chattanooga, TN';
  await a.handleRouteSubmit({ preventDefault() {} });
  assert.equal(request.origin.lat, 35);
  assert.equal(request.origin.lng, -85);
  assert.equal(request.destination, 'Chattanooga, TN');
  assert.equal(a.node('origin').value, 'My location');
  a.node('swap-button').events.click();
  await a.handleRouteSubmit({ preventDefault() {} });
  assert.equal(request.origin, 'Chattanooga, TN');
  assert.equal(request.destination.lat, 35);
});

test('car follows fresh GPS, respects map dragging, and pauses on inaccurate or stale fixes', () => {
  const a = app();
  a.toggleDriving();
  a.gps.update(a.location);
  assert.equal(a.state.locationMarker.position.lat, 35);
  assert.match(a.state.locationMarker.options.icon.html, /rotate\(0 44 44\)/);
  const pans = a.map.pans.length;
  a.map.handlers.dragstart();
  a.gps.update({ ...a.location, coords: { ...a.location.coords, latitude: 35.001, heading: 90 } });
  assert.equal(a.map.pans.length, pans);
  assert.equal(a.state.locationMarker.position.lat, 35.001);
  a.gps.update({ ...a.location, coords: { ...a.location.coords, latitude: 40, accuracy: 300 } });
  assert.equal(a.state.locationMarker.position.lat, 35.001);
  a.gps.update({ ...a.location, timestamp: Date.now() - 30000 });
  assert.equal(a.state.locationMarker.position.lat, 35.001);
  assert.match(a.node('drive-hud-status').textContent, /paused/);
  a.stopDriving();
  assert.equal(a.gps.cleared, 7);
  assert.equal(a.node('drive-hud').hidden, true);
});

test('camera reports select their coordinates by tapping the map', () => {
  const a = app();
  a.beginReport();
  assert.equal(a.node('report-hint').hidden, false);
  a.selectReportLocation({ lat: 35, lng: -85 });
  assert.equal(a.node('report-lat').value, 35);
  assert.equal(a.node('report-dialog').open, true);
  assert.equal(a.node('report-hint').hidden, true);
});
