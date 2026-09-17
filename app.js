import {
  haversineMeters,
  brandGroup,
  buildGoogleMapsUrl,
  camerasFromCsv,
  camerasFromGeoJson,
  camerasNearPath,
  escapeHtml,
  formatDistance,
  formatDuration,
  mergeCameras,
  normalizeCamera,
  toFeatureCollection,
  travelHeading,
} from "./core.js";
import { CameraPositionIndex } from "./camera-index.js";

const CAMERA_INDEX_URLS = {
  binaryUrl: "https://tiles.dontgetflocked.com/cameras-us-hourly-index.bin",
  metadataUrl: "https://tiles.dontgetflocked.com/cameras-us-hourly-index.json",
};
const API_KEY_STORAGE = "openroad.googleMapsApiKey.v1";
const REPORTS_STORAGE = "openroad.cameraReports.v1";
const DEFAULT_CENTER = { lat: 34.93, lng: -85.23 };
const EXPOSURE_CORRIDOR_METERS = 60;
const MAX_VISIBLE_CAMERAS = 3000;

const elements = Object.fromEntries([
  "data-status", "total-count", "visible-count", "local-count", "settings-button", "settings-dialog", "settings-form",
  "api-key", "remember-key", "setup-button", "map-empty", "route-form", "route-button", "origin", "destination",
  "swap-button", "location-button", "route-results", "route-cards", "selected-summary", "google-maps-link",
  "directions-toggle", "directions-list", "route-warning", "clear-route-button", "filter-row", "report-button",
  "report-dialog", "report-form", "report-lat", "report-lng", "report-brand", "report-confidence", "report-source",
  "report-notes", "import-input", "export-button", "about-data-button", "about-dialog", "toast", "recenter-button",
  "drive-button", "drive-status", "voice-alerts", "alert-distance",
  "mobile-panel-toggle", "sidebar", "install-button",
  "close-panel-button", "map-drive-button", "map-dock", "drive-hud", "drive-hud-title", "drive-hud-status",
  "stop-drive-button", "report-hint", "cancel-report-button", "change-report-location", "route-connection",
].map((id) => [id.replaceAll("-", "_"), document.getElementById(id)]));

const state = {
  map: null,
  provider: "osm",
  watchId: null,
  locationMarker: null,
  alerted: new Map(),
  wakeLock: null,
  dataLayer: null,
  infoWindow: null,
  cameraIndex: null,
  localCameras: loadLocalReports(),
  visibleRemoteIds: new Set(),
  filter: "all",
  routeClass: null,
  routes: [],
  selectedRouteIndex: 0,
  routePolylines: [],
  routeMarkers: [],
  reportMode: false,
  userLocation: null,
  lastFix: null,
  heading: null,
  followLocation: false,
  locationRequest: 0,
  endpoints: { origin: "current", destination: "address" },
  routeEndpoints: null,
  driveTimer: null,
  installPrompt: null,
};

let toastTimer;
bootstrap();

async function bootstrap() {
  bindEvents();
  initializeOpenMap();
  updateLocalCount();
  void loadCameraIndex();
  const storedKey = localStorage.getItem(API_KEY_STORAGE);
  if (storedKey) {
    elements.api_key.value = storedKey;
    try { await initializeGoogleMaps(storedKey); }
    catch (error) { handleMapError(error); }
  }
  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    let reloading = false;
    const wasControlled = Boolean(navigator.serviceWorker.controller);
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (wasControlled && !reloading) { reloading = true; location.reload(); }
    });
    const register = () => navigator.serviceWorker.register("./sw.js").catch(() => {});
    if (document.readyState === "complete") void register();
    else window.addEventListener("load", register, { once: true });
  }
}

function bindEvents() {
  elements.drive_button.addEventListener("click", toggleDriving);
  elements.map_drive_button.addEventListener("click", toggleDriving);
  elements.stop_drive_button.addEventListener("click", stopDriving);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && state.watchId !== null) void keepAwake();
  });
  elements.setup_button.addEventListener("click", openSettings);
  elements.settings_button.addEventListener("click", openSettings);
  elements.settings_form.addEventListener("submit", handleSettingsSubmit);
  elements.route_form.addEventListener("submit", handleRouteSubmit);
  elements.swap_button.addEventListener("click", () => {
    [elements.origin.value, elements.destination.value] = [elements.destination.value, elements.origin.value];
    [state.endpoints.origin, state.endpoints.destination] = [state.endpoints.destination, state.endpoints.origin];
    state.locationRequest++;
  });
  for (const endpoint of ["origin", "destination"]) {
    elements[endpoint].addEventListener("input", () => {
      state.endpoints[endpoint] = "address";
      state.locationRequest++;
    });
  }
  elements.location_button.addEventListener("click", useCurrentLocation);
  elements.recenter_button.addEventListener("click", recenterMap);
  elements.clear_route_button.addEventListener("click", clearRoute);
  elements.directions_toggle.addEventListener("click", () => {
    elements.directions_list.hidden = !elements.directions_list.hidden;
    elements.directions_toggle.textContent = elements.directions_list.hidden ? "Show directions" : "Hide directions";
  });
  elements.filter_row.addEventListener("click", (event) => {
    const button = event.target.closest("[data-brand]");
    if (!button) return;
    state.filter = button.dataset.brand;
    elements.filter_row.querySelectorAll("[data-brand]").forEach((chip) => chip.classList.toggle("active", chip === button));
    refreshVisibleCameras();
  });
  elements.report_button.addEventListener("click", beginReport);
  elements.change_report_location.addEventListener("click", () => {
    elements.report_dialog.close();
    beginReport();
  });
  elements.cancel_report_button.addEventListener("click", cancelReport);
  elements.report_form.addEventListener("submit", saveReport);
  elements.import_input.addEventListener("change", importCameraFile);
  elements.export_button.addEventListener("click", exportReports);
  elements.about_data_button.addEventListener("click", () => elements.about_dialog.showModal());
  document.querySelectorAll("[data-close-dialog]").forEach((button) => button.addEventListener("click", () => button.closest("dialog")?.close()));
  elements.mobile_panel_toggle.addEventListener("click", () => {
    setPanelOpen(true);
    elements.sidebar.scrollTop = 0;
    elements.destination.focus({ preventScroll: true });
  });
  elements.close_panel_button.addEventListener("click", () => setPanelOpen(false, true));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { setPanelOpen(false, true); cancelReport(); }
  });
  window.addEventListener("resize", syncPanelAccess);
  syncPanelAccess();
  document.addEventListener("pointerdown", (event) => {
    if (window.innerWidth <= 860 && elements.sidebar.classList.contains("open") && !elements.sidebar.contains(event.target) && !elements.mobile_panel_toggle.contains(event.target)) {
      setPanelOpen(false);
    }
  });
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    state.installPrompt = event;
    elements.install_button.hidden = false;
  });
  elements.install_button.addEventListener("click", async () => {
    if (!state.installPrompt) return;
    state.installPrompt.prompt();
    await state.installPrompt.userChoice;
    state.installPrompt = null;
    elements.install_button.hidden = true;
  });
}

function syncPanelAccess() {
  elements.sidebar.inert = window.innerWidth <= 860 && !elements.sidebar.classList.contains("open");
}

function setPanelOpen(open, returnFocus = false) {
  elements.sidebar.classList.toggle("open", open);
  elements.mobile_panel_toggle.setAttribute("aria-expanded", String(open));
  syncPanelAccess();
  if (!open && returnFocus && window.innerWidth <= 860) elements.mobile_panel_toggle.focus();
}

async function loadCameraIndex() {
  try {
    state.cameraIndex = await CameraPositionIndex.load(CAMERA_INDEX_URLS);
    elements.total_count.textContent = state.cameraIndex.count.toLocaleString();
    elements.data_status.classList.add("ready");
    elements.data_status.classList.remove("error");
    elements.data_status.lastChild.textContent = ` ${state.cameraIndex.count.toLocaleString()} indexed`;
    refreshVisibleCameras();
  } catch (error) {
    console.warn(error);
    elements.total_count.textContent = "Offline";
    elements.data_status.classList.add("error");
    elements.data_status.lastChild.textContent = " Live index unavailable";
    toast("The live community index could not load. Local imports and reports still work.");
  }
}

function openSettings() {
  elements.settings_dialog.showModal();
  setTimeout(() => elements.api_key.focus(), 80);
}

async function handleSettingsSubmit(event) {
  event.preventDefault();
  const key = elements.api_key.value.trim();
  if (!key) return toast("Enter a Google Maps API key first.");
  const button = document.getElementById("save-key-button");
  button.disabled = true;
  button.textContent = "Loading…";
  if (elements.remember_key.checked) localStorage.setItem(API_KEY_STORAGE, key);
  else localStorage.removeItem(API_KEY_STORAGE);
  try {
    await initializeGoogleMaps(key);
    elements.settings_dialog.close();
  } catch (error) {
    handleMapError(error);
  } finally {
    button.disabled = false;
    button.textContent = "Save & load map";
  }
}

function loadGoogleMapsScript(apiKey) {
  if (window.google?.maps?.importLibrary) return Promise.resolve();
  if (window.__openRoadGooglePromise) return window.__openRoadGooglePromise;
  window.__openRoadGooglePromise = new Promise((resolve, reject) => {
    const callback = `__openRoadMapsReady_${Date.now()}`;
    window[callback] = () => {
      delete window[callback];
      resolve();
    };
    const script = document.createElement("script");
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&v=weekly&loading=async&libraries=routes&callback=${callback}`;
    script.async = true;
    script.onerror = () => reject(new Error("Google Maps script failed to load."));
    document.head.append(script);
    setTimeout(() => reject(new Error("Google Maps timed out while loading.")), 20_000);
  });
  return window.__openRoadGooglePromise;
}

async function initializeGoogleMaps(apiKey) {
  await loadGoogleMapsScript(apiKey);
  const [{ Map }, { Route }] = await Promise.all([
    google.maps.importLibrary("maps"),
    google.maps.importLibrary("routes"),
    google.maps.importLibrary("marker"),
  ]);
  stopDriving();
  removeLocationMarker();
  clearRoute();
  if (state.provider === "osm" && state.map) state.map.remove();
  state.provider = "google";
  state.routeClass = Route;
  state.map = new Map(document.getElementById("map"), {
    center: state.userLocation || DEFAULT_CENTER,
    zoom: 11,
    mapTypeControl: false,
    streetViewControl: false,
    fullscreenControl: false,
    clickableIcons: false,
    gestureHandling: "greedy",
    mapId: "DEMO_MAP_ID",
  });
  state.dataLayer = new google.maps.Data({ map: state.map });
  state.infoWindow = new google.maps.InfoWindow();
  state.dataLayer.setStyle(cameraStyle);
  state.dataLayer.addListener("click", showCameraInfo);
  state.map.addListener("idle", refreshVisibleCameras);
  state.map.addListener("dragstart", pauseFollowing);
  state.map.addListener("click", (event) => {
    if (!state.reportMode) return;
    selectReportLocation({ lat: event.latLng.lat(), lng: event.latLng.lng() });
  });
  elements.map_empty.hidden = true;
  elements.route_connection.hidden = true;
  if (state.userLocation) renderLocationMarker();
  refreshVisibleCameras();
  toast("Map connected. Camera index and route comparison are ready.");
}

function handleMapError(error) {
  console.error(error);
  window.__openRoadGooglePromise = null;
  toast("Google Maps could not load. Check the key, enabled APIs, billing, and referrer restrictions.");
}

function cameraStyle(feature) {
  const brand = feature.getProperty("brand") || "Unknown ALPR";
  const origin = feature.getProperty("origin");
  const group = brandGroup(brand);
  const hidden = state.filter !== "all" && state.filter !== group;
  const color = origin === "local" ? "#f2ba49" : group === "flock" ? "#de6b38" : group === "other" ? "#1f6d55" : "#71817b";
  return {
    visible: !hidden,
    icon: {
      path: google.maps.SymbolPath.CIRCLE,
      fillColor: color,
      fillOpacity: 0.9,
      strokeColor: origin === "local" ? "#10251f" : "#ffffff",
      strokeWeight: origin === "local" ? 2.2 : 1.2,
      scale: origin === "local" ? 6.5 : 5,
    },
    zIndex: origin === "local" ? 20 : 5,
  };
}

function refreshVisibleCameras() {
  if (state.provider === "osm") return refreshOpenMap();
  if (!state.map || !state.dataLayer) return;
  const currentFeatures = [];
  state.dataLayer.forEach((feature) => currentFeatures.push(feature));
  currentFeatures.forEach((feature) => state.dataLayer.remove(feature));
  let visibleRemote = [];
  let visibleLocal = [];
  const bounds = state.map.getBounds();
  const zoom = state.map.getZoom() || 0;
  if (state.cameraIndex && bounds && zoom >= 8) {
    const northEast = bounds.getNorthEast();
    const southWest = bounds.getSouthWest();
    const remoteCandidates = state.cameraIndex.queryBounds({
      south: southWest.lat(),
      west: southWest.lng(),
      north: northEast.lat(),
      east: northEast.lng(),
    }, MAX_VISIBLE_CAMERAS * 4);
    visibleRemote = remoteCandidates
      .filter((index) => state.filter === "all" || brandGroup(state.cameraIndex.get(index).brand) === state.filter)
      .slice(0, MAX_VISIBLE_CAMERAS);
    for (const index of visibleRemote) addCameraFeature(state.cameraIndex.get(index));
  }
  if (bounds && zoom >= 8) {
    visibleLocal = state.localCameras
      .filter((camera) => bounds.contains(camera))
      .filter((camera) => state.filter === "all" || brandGroup(camera.brand) === state.filter)
      .slice(0, MAX_VISIBLE_CAMERAS);
  }
  for (const camera of visibleLocal) addCameraFeature(camera);
  state.visibleRemoteIds = new Set(visibleRemote);
  elements.visible_count.textContent = (visibleRemote.length + visibleLocal.length).toLocaleString();
  if (zoom < 8 && state.cameraIndex) elements.visible_count.title = "Zoom in to show individual indexed points";
}

function addCameraFeature(camera) {
  if (!camera) return;
  state.dataLayer.add(new google.maps.Data.Feature({
    id: camera.id,
    geometry: new google.maps.Data.Point(new google.maps.LatLng(camera.lat, camera.lng)),
    properties: camera,
  }));
}

function showCameraInfo(event) {
  const property = (name) => event.feature.getProperty(name) || "";
  const brand = property("brand") || "Unknown ALPR";
  const sourceUrl = property("sourceUrl");
  const origin = property("origin");
  const source = origin === "deflock-osm" ? "OpenStreetMap via DeFlock" : "Local report";
  const details = [property("confidence"), property("lastVerified")].filter(Boolean).join(" • ");
  state.infoWindow.setContent(`
    <div class="camera-popup">
      <div class="popup-kicker">${escapeHtml(source)}</div>
      <h3>${escapeHtml(brand)}</h3>
      <p>${escapeHtml(details || "Community-reported location")}</p>
      ${property("notes") ? `<p>${escapeHtml(property("notes"))}</p>` : ""}
      ${sourceUrl && /^https?:\/\//i.test(sourceUrl) ? `<a href="${escapeHtml(sourceUrl)}" target="_blank" rel="noreferrer">View source</a>` : ""}
    </div>
  `);
  state.infoWindow.setPosition(event.latLng);
  state.infoWindow.open({ map: state.map });
}

async function handleRouteSubmit(event) {
  event.preventDefault();
  if (!state.map || !state.routeClass) {
    openSettings();
    return toast("Connect Google Maps before planning a route.");
  }
  if (!state.cameraIndex) return toast("Wait for the camera index before comparing exposure. Reload if it could not load.");
  if (!elements.origin.value.trim() || !elements.destination.value.trim()) return;
  elements.route_button.disabled = true;
  elements.route_button.querySelector("span").textContent = "Comparing…";
  clearRoute();
  try {
    // Resolve GPS at submission, while retaining human-readable labels in the form.
    const endpointKinds = { ...state.endpoints };
    const endpointText = { origin: elements.origin.value.trim(), destination: elements.destination.value.trim() };
    const fix = Object.values(endpointKinds).includes("current") ? await getLocationFix() : null;
    if (fix) acceptLocationFix(fix);
    const point = fix ? { lat: fix.coords.latitude, lng: fix.coords.longitude } : null;
    const origin = endpointKinds.origin === "current" ? point : endpointText.origin;
    const destination = endpointKinds.destination === "current" ? point : endpointText.destination;
    const { routes } = await state.routeClass.computeRoutes({
      origin,
      destination,
      travelMode: "DRIVING",
      routingPreference: "TRAFFIC_AWARE",
      computeAlternativeRoutes: true,
      polylineQuality: "HIGH_QUALITY",
      units: "IMPERIAL",
      fields: [
        "path", "distanceMeters", "durationMillis", "description", "viewport", "warnings",
        "legs", "legs.steps.instructions", "legs.steps.localizedValues",
      ],
    });
    if (!routes?.length) throw new Error("No drivable route was returned.");
    state.routeEndpoints = { origin, destination };
    pauseFollowing();
    state.routes = routes.map((route, index) => scoreRoute(route, index));
    const priority = new FormData(elements.route_form).get("priority");
    state.selectedRouteIndex = chooseRouteIndex(state.routes, priority);
    renderRoutes();
    elements.route_results.hidden = false;
    elements.route_results.scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (error) {
    console.error(error);
    toast(error?.message || "No route could be calculated. Check both locations and your API setup.");
  } finally {
    elements.route_button.disabled = false;
    elements.route_button.querySelector("span").textContent = "Compare routes";
  }
}

function scoreRoute(route, index) {
  const path = (route.path || []).map(toLiteral).filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng));
  const indexedMatches = state.cameraIndex ? state.cameraIndex.findNearPath(path, EXPOSURE_CORRIDOR_METERS) : [];
  const localMatches = camerasNearPath(state.localCameras, path, EXPOSURE_CORRIDOR_METERS);
  return {
    route,
    index,
    path,
    exposures: mergeCameras(indexedMatches, localMatches),
    distanceMeters: route.distanceMeters,
    durationMillis: route.durationMillis,
    name: route.description || (index === 0 ? "Recommended route" : `Alternative ${index + 1}`),
  };
}

function chooseRouteIndex(routes, priority) {
  if (priority === "fastest") {
    return routes.reduce((best, route, index) => route.durationMillis < routes[best].durationMillis ? index : best, 0);
  }
  return routes.reduce((best, route, index) => {
    const bestRoute = routes[best];
    if (route.exposures.length !== bestRoute.exposures.length) return route.exposures.length < bestRoute.exposures.length ? index : best;
    return route.durationMillis < bestRoute.durationMillis ? index : best;
  }, 0);
}

function renderRoutes() {
  clearRouteGraphics();
  state.routePolylines = state.routes.map((item, index) => {
    const selected = index === state.selectedRouteIndex;
    const polylines = item.route.createPolylines({
      polylineOptions: {
        strokeColor: selected ? "#124939" : "#8fa39b",
        strokeOpacity: selected ? 0.95 : 0.48,
        strokeWeight: selected ? 7 : 5,
        zIndex: selected ? 8 : 3,
      },
    });
    for (const polyline of polylines) {
      polyline.setMap(state.map);
      polyline.addListener("click", () => selectRoute(index));
    }
    return polylines;
  });
  const selected = state.routes[state.selectedRouteIndex];
  if (selected.route.viewport) state.map.fitBounds(selected.route.viewport, 55);
  state.routeMarkers = [];
  void selected.route.createWaypointAdvancedMarkers().then((markers) => {
    state.routeMarkers = markers;
    markers.forEach((marker) => { marker.map = state.map; });
  }).catch(() => {});
  renderRouteCards();
  renderSelectedRoute();
}

function renderRouteCards() {
  const fewest = Math.min(...state.routes.map((route) => route.exposures.length));
  const fastest = Math.min(...state.routes.map((route) => route.durationMillis));
  elements.route_cards.innerHTML = state.routes.map((item, index) => {
    const badges = [];
    if (item.exposures.length === fewest) badges.push("Fewest readers");
    else if (item.durationMillis === fastest) badges.push("Fastest");
    return `
      <button class="route-card ${index === state.selectedRouteIndex ? "selected" : ""}" type="button" data-route-index="${index}">
        <div class="route-card-top">
          <span class="route-card-name">${escapeHtml(item.name)}</span>
          ${badges.length ? `<span class="route-badge">${badges[0]}</span>` : ""}
        </div>
        <div class="route-metrics">
          <strong>${formatDuration(item.durationMillis)}</strong>
          <span>${formatDistance(item.distanceMeters)}</span>
          <span class="exposure-count">${item.exposures.length} reported ${item.exposures.length === 1 ? "reader" : "readers"}</span>
        </div>
      </button>
    `;
  }).join("");
  elements.route_cards.querySelectorAll("[data-route-index]").forEach((button) => button.addEventListener("click", () => selectRoute(Number(button.dataset.routeIndex))));
}

function selectRoute(index) {
  state.selectedRouteIndex = index;
  renderRoutes();
}

function renderSelectedRoute() {
  const item = state.routes[state.selectedRouteIndex];
  if (!item) return;
  const knownBrands = new Set(item.exposures.map((camera) => camera.brand).filter(Boolean)).size;
  elements.selected_summary.innerHTML = `
    <div class="summary-stat"><strong>${item.exposures.length}</strong><span>Reported readers</span></div>
    <div class="summary-stat"><strong>${knownBrands}</strong><span>Known brands</span></div>
    <div class="summary-stat"><strong>${EXPOSURE_CORRIDOR_METERS} m</strong><span>Count corridor</span></div>
  `;
  const linkValue = (endpoint) => typeof endpoint === "string" ? endpoint : `${endpoint.lat},${endpoint.lng}`;
  elements.google_maps_link.href = buildGoogleMapsUrl(linkValue(state.routeEndpoints.origin), linkValue(state.routeEndpoints.destination), item.path);
  const steps = (item.route.legs || []).flatMap((leg) => leg.steps || []);
  elements.directions_list.innerHTML = steps.map((step) => `
    <li>${escapeHtml(step.instructions || "Continue")}<span>${escapeHtml(step.localizedValues?.distance || "")}</span></li>
  `).join("");
  const warnings = item.route.warnings || [];
  const recalcWarning = "Opening Google Maps may recalculate the trip; verify that its displayed path still matches the selected alternative.";
  elements.route_warning.textContent = [...warnings, recalcWarning].join(" ");
}

function clearRoute() {
  clearRouteGraphics();
  state.routes = [];
  state.routeEndpoints = null;
  elements.route_results.hidden = true;
  elements.directions_list.hidden = true;
  elements.directions_toggle.textContent = "Show directions";
}

function clearRouteGraphics() {
  state.routePolylines.flat().forEach((polyline) => polyline.setMap(null));
  state.routeMarkers.forEach((marker) => { marker.map = null; });
  state.routePolylines = [];
  state.routeMarkers = [];
}

function toLiteral(point) {
  return {
    lat: typeof point.lat === "function" ? point.lat() : Number(point.lat),
    lng: typeof point.lng === "function" ? point.lng() : Number(point.lng),
  };
}

function beginReport() {
  if (state.watchId !== null) return toast("Stop driving mode before adding a report.");
  if (!state.map) return toast("Wait for the map to load, then tap the camera’s location.");
  elements.report_lat.value = "";
  elements.report_lng.value = "";
  state.reportMode = true;
  state.followLocation = false;
  elements.report_hint.hidden = false;
  elements.map_dock.hidden = true;
  setPanelOpen(false);
}

function cancelReport() {
  state.reportMode = false;
  elements.report_hint.hidden = true;
  elements.map_dock.hidden = false;
}

function selectReportLocation(point) {
  cancelReport();
  elements.report_lat.value = point.lat;
  elements.report_lng.value = point.lng;
  elements.report_dialog.showModal();
}

function saveReport(event) {
  event.preventDefault();
  if (!elements.report_lat.value || !elements.report_lng.value) return toast("Choose the camera’s location on the map first.");
  const camera = normalizeCamera({
    id: `report-${crypto.randomUUID?.() || Date.now()}`,
    lat: elements.report_lat.value,
    lng: elements.report_lng.value,
    brand: elements.report_brand.value,
    confidence: elements.report_confidence.value,
    sourceUrl: elements.report_source.value,
    notes: elements.report_notes.value,
    lastVerified: new Date().toISOString().slice(0, 10),
    origin: "local",
  });
  if (!camera) return toast("Choose the camera’s location on the map again.");
  state.localCameras = mergeCameras(state.localCameras, [camera]);
  persistLocalReports();
  updateLocalCount();
  refreshVisibleCameras();
  elements.report_form.reset();
  elements.report_dialog.close();
  if (state.map) {
    state.map.panTo(camera);
    state.map.setZoom(Math.max(state.map.getZoom() || 0, 16));
  }
  toast("Camera report saved on this device.");
}

async function importCameraFile(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    const cameras = /\.csv$/i.test(file.name) ? camerasFromCsv(text) : camerasFromGeoJson(text);
    if (!cameras.length) throw new Error("No valid Point camera records were found.");
    const before = state.localCameras.length;
    state.localCameras = mergeCameras(state.localCameras, cameras.map((camera) => ({ ...camera, origin: "local" })));
    persistLocalReports();
    updateLocalCount();
    refreshVisibleCameras();
    toast(`Imported ${state.localCameras.length - before} new camera ${state.localCameras.length - before === 1 ? "report" : "reports"}.`);
  } catch (error) {
    toast(error.message || "That file could not be imported.");
  } finally {
    event.target.value = "";
  }
}

function exportReports() {
  if (!state.localCameras.length) return toast("There are no local reports to export yet.");
  const blob = new Blob([JSON.stringify(toFeatureCollection(state.localCameras), null, 2)], { type: "application/geo+json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `openroad-camera-reports-${new Date().toISOString().slice(0, 10)}.geojson`;
  link.click();
  URL.revokeObjectURL(url);
}

function loadLocalReports() {
  try {
    const value = JSON.parse(localStorage.getItem(REPORTS_STORAGE) || "[]");
    return Array.isArray(value) ? value.map((camera, index) => normalizeCamera(camera, index)).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function persistLocalReports() {
  localStorage.setItem(REPORTS_STORAGE, JSON.stringify(state.localCameras));
}

function updateLocalCount() {
  elements.local_count.textContent = state.localCameras.length.toLocaleString();
}

function getLocationFix() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("Location is unavailable. Enter a starting address instead."));
    navigator.geolocation.getCurrentPosition((position) => {
      if (!isUsableFix(position)) return reject(new Error("Your location signal is weak. Try again or enter a starting address."));
      resolve(position);
    }, (error) => reject(new Error(error.code === 1
      ? "Allow location in your browser, or enter a starting address."
      : "Couldn’t find your location. Try again or enter a starting address.")),
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 });
  });
}

async function useCurrentLocation() {
  const request = ++state.locationRequest;
  elements.location_button.disabled = true;
  toast("Finding your location…");
  try {
    const fix = await getLocationFix();
    if (request !== state.locationRequest) return;
    acceptLocationFix(fix);
    state.endpoints.origin = "current";
    elements.origin.value = "My location";
    centerOnCar();
  } catch (error) { toast(error.message); }
  finally { elements.location_button.disabled = false; }
}

async function recenterMap() {
  try {
    acceptLocationFix(await getLocationFix());
    centerOnCar();
  } catch (error) { toast(error.message); }
}

function centerOnCar() {
  state.followLocation = state.watchId !== null;
  elements.recenter_button.classList.toggle("following", state.followLocation);
  elements.recenter_button.querySelector("span").textContent = state.followLocation ? "Following" : "My location";
  if (state.map && state.userLocation) {
    state.map.panTo(state.userLocation);
    state.map.setZoom(Math.max(state.map.getZoom(), 16));
  }
}

function pauseFollowing() {
  state.followLocation = false;
  elements.recenter_button.classList.remove("following");
  elements.recenter_button.querySelector("span").textContent = state.userLocation ? "Recenter" : "Locate me";
}

function isUsableFix(position) {
  return Number.isFinite(position.coords.latitude) && Number.isFinite(position.coords.longitude)
    && Number.isFinite(position.coords.accuracy) && position.coords.accuracy <= 100
    && Date.now() - position.timestamp <= 15000;
}

function acceptLocationFix(position) {
  if (state.lastFix && position.timestamp < state.lastFix.timestamp) return;
  state.heading = travelHeading(position, state.lastFix, state.heading);
  state.lastFix = position;
  state.userLocation = { lat: position.coords.latitude, lng: position.coords.longitude };
  renderLocationMarker();
}

function carSvg(heading) {
  const angle = Number.isFinite(heading) ? heading : 0;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 88 88" width="88" height="88">
    <circle cx="44" cy="44" r="25" fill="#3979f2" fill-opacity=".14"/>
    <g transform="rotate(${angle} 44 44)">
      ${heading !== null ? '<path d="M44 2 23 31Q44 22 65 31Z" fill="#3979f2" fill-opacity=".25"/>' : ""}
      <ellipse cx="44" cy="48" rx="17" ry="25" fill="#102b52" fill-opacity=".2"/>
      <rect x="28" y="28" width="5" height="13" rx="2" fill="#173454"/><rect x="55" y="28" width="5" height="13" rx="2" fill="#173454"/>
      <rect x="29" y="50" width="5" height="13" rx="2" fill="#173454"/><rect x="54" y="50" width="5" height="13" rx="2" fill="#173454"/>
      <rect x="32" y="19" width="24" height="48" rx="9" fill="#3478f6" stroke="#fff" stroke-width="2.5"/>
      <path d="m36 30 16 0-2 10H38Z" fill="#d7efff"/>
      <rect x="38" y="42" width="12" height="10" rx="3" fill="#2160d0"/>
      <path d="M38 54h12l2 6H36Z" fill="#b4dcff"/>
      <path d="M35 25h4m10 0h4" stroke="#fff" stroke-width="3" stroke-linecap="round"/>
      <path d="M35 63h4m10 0h4" stroke="#ffb5ad" stroke-width="2" stroke-linecap="round"/>
    </g></svg>`;
}

function renderLocationMarker() {
  if (!state.map || !state.userLocation) return;
  const svg = carSvg(state.heading);
  if (state.provider === "osm") {
    const icon = L.divIcon({ className: "driving-car", html: svg, iconSize: [88, 88], iconAnchor: [44, 44] });
    if (!state.locationMarker) state.locationMarker = L.marker(state.userLocation, { icon, title: "Your car • GPS location", keyboard: false, interactive: false, zIndexOffset: 1000 }).addTo(state.map);
    else state.locationMarker.setLatLng(state.userLocation).setIcon(icon);
  } else {
    const icon = { url: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`, scaledSize: new google.maps.Size(88, 88), anchor: new google.maps.Point(44, 44) };
    if (!state.locationMarker) state.locationMarker = new google.maps.Marker({ map: state.map, position: state.userLocation, title: "Your car • GPS location", icon, zIndex: 1000, clickable: false, optimized: false });
    else { state.locationMarker.setPosition(state.userLocation); state.locationMarker.setIcon(icon); }
  }
}

function removeLocationMarker() {
  if (state.provider === "osm") state.locationMarker?.remove();
  else state.locationMarker?.setMap(null);
  state.locationMarker = null;
}

function toast(message) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.add("show");
  toastTimer = setTimeout(() => elements.toast.classList.remove("show"), 4200);
}


// OpenStreetMap is immediately usable; Google is an optional routing upgrade.
function initializeOpenMap() {
  if (!window.L) return toast("The map could not load. Reload when connected.");
  state.map = L.map("map", { preferCanvas: true, zoomControl: false }).setView(DEFAULT_CENTER, 12);
  L.control.zoom({ position: "bottomright" }).addTo(state.map);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',
  }).addTo(state.map);
  state.dataLayer = L.layerGroup().addTo(state.map);
  state.map.on("moveend", refreshVisibleCameras);
  state.map.on("dragstart", pauseFollowing);
  state.map.on("click", (event) => {
    if (!state.reportMode) return;
    selectReportLocation(event.latlng);
  });
  elements.map_empty.hidden = true;
  refreshOpenMap();
}

function refreshOpenMap() {
  if (!state.map || !state.dataLayer) return;
  state.dataLayer.clearLayers();
  const b = state.map.getBounds();
  const remote = state.cameraIndex && state.map.getZoom() >= 8
    ? state.cameraIndex.queryBounds({ south: b.getSouth(), north: b.getNorth(), west: b.getWest(), east: b.getEast() }, 12000).map(i => state.cameraIndex.get(i)) : [];
  const cameras = [...remote, ...state.localCameras.filter(c => b.contains(c))]
    .filter(c => state.filter === "all" || brandGroup(c.brand) === state.filter).slice(0, MAX_VISIBLE_CAMERAS);
  for (const c of cameras) {
    const color = c.origin === "local" ? "#ae7400" : brandGroup(c.brand) === "flock" ? "#cf5022" : "#145d62";
    const popup = document.createElement("div");
    popup.textContent = `${c.brand} — ${c.origin === "local" ? "Local report" : "OpenStreetMap / DeFlock"}`;
    L.circleMarker(c, { radius: 6, color: "#fff", weight: 1.5, fillColor: color, fillOpacity: 0.95 }).bindPopup(popup).addTo(state.dataLayer);
  }
  elements.visible_count.textContent = cameras.length.toLocaleString();
}

async function keepAwake() {
  try {
    const lock = await navigator.wakeLock?.request("screen");
    if (state.watchId === null) await lock?.release();
    else state.wakeLock = lock;
  } catch { /* Not supported or denied: the foreground guidance remains visible. */ }
}

function stopDriving() {
  if (state.watchId !== null) navigator.geolocation.clearWatch(state.watchId);
  state.watchId = null;
  void state.wakeLock?.release();
  state.wakeLock = null;
  window.speechSynthesis?.cancel();
  clearInterval(state.driveTimer);
  state.driveTimer = null;
  pauseFollowing();
  state.alerted.clear();
  elements.drive_button.textContent = "Start driving";
  elements.drive_button.setAttribute("aria-pressed", "false");
  elements.map_drive_button.querySelector("span").textContent = "Start driving";
  elements.map_drive_button.setAttribute("aria-pressed", "false");
  elements.drive_hud.hidden = true;
  elements.drive_status.textContent = state.userLocation
    ? "Driving stopped. Your car shows your last location."
    : "Ready when you are. Allow location to put your car on the map.";
}

function toggleDriving() {
  if (state.watchId !== null) return stopDriving();
  if (!state.map) return toast("Wait for the map to load.");
  if (!navigator.geolocation) return toast("This browser does not support location.");
  cancelReport();
  setPanelOpen(false);
  state.followLocation = true;
  state.lastFix = null;
  elements.drive_button.textContent = "Stop driving";
  elements.drive_button.setAttribute("aria-pressed", "true");
  elements.map_drive_button.querySelector("span").textContent = "Stop driving";
  elements.map_drive_button.setAttribute("aria-pressed", "true");
  elements.drive_hud.hidden = false;
  setDriveStatus("Finding your location…", "Allow location to see your car on the map.");
  state.map.setZoom(16);
  // Starting speech from the button gesture enables speech on mobile browsers.
  if (elements.voice_alerts.checked && window.speechSynthesis) {
    speechSynthesis.speak(new SpeechSynthesisUtterance("Driving mode started"));
  }
  state.watchId = navigator.geolocation.watchPosition(updateDrivingPosition, (error) => {
    if (error.code === 1) { stopDriving(); toast("Allow location access to use driving mode."); }
    else setDriveStatus("Waiting for location", "Camera alerts paused. Your car shows its last location.");
  }, { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 });
  state.driveTimer = setInterval(() => {
    if (state.lastFix && Date.now() - state.lastFix.timestamp > 15000) {
      setDriveStatus("Waiting for location", "Camera alerts paused. Your car shows its last location.");
    }
  }, 5000);
  void keepAwake();
}

function setDriveStatus(title, message) {
  elements.drive_hud_title.textContent = title;
  elements.drive_hud_status.textContent = message;
  elements.drive_status.textContent = message;
}

function updateDrivingPosition(position) {
  if (state.watchId === null) return;
  const point = { lat: position.coords.latitude, lng: position.coords.longitude };
  if (!isUsableFix(position)) {
    setDriveStatus("Weak location signal", "Camera alerts paused until your location improves.");
    return;
  }
  if (state.lastFix && position.timestamp < state.lastFix.timestamp) return;
  acceptLocationFix(position);
  if (state.followLocation) {
    state.map.panTo(point);
    elements.recenter_button.classList.add("following");
    elements.recenter_button.querySelector("span").textContent = "Following";
  }
  const radius = Number(elements.alert_distance.value);
  const latPad = radius / 110574;
  const lngPad = radius / Math.max(1000, 111320 * Math.cos(point.lat * Math.PI / 180));
  const indexed = state.cameraIndex ? state.cameraIndex.queryBounds({ south: point.lat - latPad, north: point.lat + latPad, west: point.lng - lngPad, east: point.lng + lngPad }).map(i => state.cameraIndex.get(i)) : [];
  const nearby = mergeCameras(indexed, state.localCameras)
    .map(camera => ({ ...camera, distance: haversineMeters(point, camera) }))
    .filter(camera => camera.distance <= radius).sort((a, b) => a.distance - b.distance);
  const nearest = nearby[0];
  setDriveStatus(nearest ? "Reported camera nearby" : "Driving mode is on", nearest
    ? `${nearest.brand} · ${Math.round(nearest.distance * 3.28084)} ft away · ${nearby.length} nearby`
    : state.cameraIndex ? `No reported cameras within ${Math.round(radius * 3.28084)} ft.` : "Live camera data unavailable. Checking your reports only.");
  const now = Date.now();
  for (const [id, time] of state.alerted) if (now - time > 300000) state.alerted.delete(id);
  const fresh = nearby.find(c => !state.alerted.has(c.id));
  if (fresh && elements.voice_alerts.checked && window.speechSynthesis && !speechSynthesis.speaking) {
    speechSynthesis.speak(new SpeechSynthesisUtterance(`Reported ${fresh.brand} camera nearby, ${Math.round(fresh.distance * 3.28084 / 50) * 50} feet away.`));
    nearby.forEach(c => state.alerted.set(c.id, now));
  }
}

if (document.modelContext?.registerTool) {
  const lifecycle = new AbortController();
  window.addEventListener("pagehide", () => lifecycle.abort(), { once: true });
  try {
    Promise.resolve(document.modelContext.registerTool({
      name: "set_camera_brand_filter",
      description: "Filter the visible camera map by brand group.",
      inputSchema: { type: "object", properties: { brand: { type: "string", enum: ["all", "flock", "other", "unknown"] } }, required: ["brand"], additionalProperties: false },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute(input) {
        if (!input || !["all", "flock", "other", "unknown"].includes(input.brand)) throw new Error("Invalid camera brand group");
        elements.filter_row.querySelector(`[data-brand="${input.brand}"]`).click();
        return { brand: state.filter, displayedCameras: elements.visible_count.textContent };
      },
    }, { signal: lifecycle.signal })).catch(() => {});
  } catch { /* Optional browser capability. */ }
}
