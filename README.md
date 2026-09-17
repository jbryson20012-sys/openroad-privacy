# OpenRoad Privacy

OpenRoad Privacy is a phone-friendly, installable web app that overlays reported ALPR locations on Google Maps and compares Google's lawful driving alternatives by estimated camera exposure.

It is a separate application built with Google Maps Platform; third-party code cannot patch or add controls directly inside the consumer Google Maps app.

## Driving mode — no API key needed

Open the app and choose **Start driving mode**, then allow location access. The OpenStreetMap camera map follows your GPS position and gives optional spoken proximity alerts at 500, 1,000 or 2,000 feet. Keep the app visible and the screen on; mobile browsers may suspend background location or audio. Alerts describe proximity in any direction, not confirmed cameras on your road. Poor GPS fixes pause alerts. Stop driving mode to stop location tracking. Your GPS track is not saved.

Google route comparisons still require your own restricted API key. This is not automatic turn-by-turn navigation or a guarantee of avoiding all cameras.

## What works

- Loads the hourly U.S. camera positions index from the community-maintained [DeFlock data pipeline](https://github.com/flockhopper3/deflock-data), derived from OpenStreetMap surveillance tags.
- Shows a free OpenStreetMap basemap immediately, with optional Google Maps routing.
- Shows brand-aware camera markers when zoomed in.
- Requests up to several ordinary driving alternatives from Google's current `Route.computeRoutes()` API.
- Counts reported cameras within a 60-meter corridor of each route.
- Chooses either the fastest route or the alternative with the fewest reported readers.
- Displays a route comparison, route polyline, and turn list.
- Opens the selected shape in Google Maps using three route-shaping waypoints. Google may still recalculate it.
- Adds local reports by tapping the map.
- Imports CSV and GeoJSON and exports local reports as GeoJSON.
- Stores API key and reports only in browser local storage.
- Installs as a Progressive Web App.

## Honest limitation

No public or crowdsourced database can contain **every** privately installed, moved, mobile, newly added, removed, or unreported ALPR. The app therefore says “reported” and shows estimates. It never promises a camera-free route.

## Google Maps setup

1. Create or choose a Google Cloud project with billing enabled.
2. Enable **Maps JavaScript API** and **Routes API**.
3. Create an API key.
4. Restrict the key to **Websites (HTTP referrers)** and add the local and deployed origins you use, such as:
   - `http://localhost:4173/*`
   - `https://jbryson20012-sys.github.io/openroad-privacy/*`
5. Open the app, select the settings button, and enter the key. Do not commit a key to the repository.

Google's current setup guide: <https://developers.google.com/maps/documentation/javascript/routes/start>

## Run locally

Requires Node.js 20 or newer.

```bash
npm start
```

Open <http://127.0.0.1:4173>.

Run checks:

```bash
npm run check
```

## Import format

Use `data/cameras-template.csv`, or provide Point GeoJSON. Recognized CSV columns include:

```text
id,latitude,longitude,brand,type,direction,confidence,last_verified,source_url,notes
```

Only latitude and longitude are required.

## Deploy with GitHub Pages

1. Create an empty GitHub repository and copy these files to its root.
2. Push to `main`.
3. In **Settings → Pages**, choose **GitHub Actions** as the source.
4. The included workflow tests and deploys the app.
5. Add the Pages URL to your Google API key's allowed HTTP referrers.

## Data attribution and licenses

Camera coordinates: © OpenStreetMap contributors, ODbL, distributed through the DeFlock data pipeline. Application code: MIT. Google Maps content and routing are subject to Google Maps Platform terms.

See [DATA_POLICY.md](DATA_POLICY.md) before publishing or accepting community contributions.
