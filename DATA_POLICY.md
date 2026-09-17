# OpenRoad Privacy data policy

OpenRoad Privacy is a public-interest, local-first map. It is designed to help people understand reported automated license plate reader (ALPR) exposure on ordinary driving routes.

## Data sources

- The built-in United States index is fetched from the community-maintained [DeFlock data pipeline](https://github.com/flockhopper3/deflock-data). Its camera coordinates are derived from OpenStreetMap surveillance tags and are offered under the Open Database License (ODbL).
- People can import their own CSV or GeoJSON files and add observations by clicking the map.
- Imported and manually added observations are stored only in the browser's local storage unless the person explicitly exports them.

## Important limitations

No public dataset can guarantee that it contains every camera. Installations may be new, private, mobile, removed, unreported, incorrectly identified, or imprecisely located. Brand labels and camera direction may be missing or wrong. Route exposure totals are estimates based on cameras within 60 meters of the route geometry.

The app should not be used for emergencies or as a substitute for road signs, closures, official directions, or safe driving judgment.

## Privacy

This static project has no application server and does not collect plate numbers, identities, trip history, or reports. A Google Maps API key can be remembered in local storage on the person's device. Google Maps requests remain subject to Google's policies. The live camera index request is subject to the data host's network logs and policy.

## Responsible contributions

Contributed records should describe cameras visible from public places or supported by public records. Do not trespass, interfere with equipment, publish personal information, or submit knowingly false records. Include a public source URL or recent observation date whenever possible.

Driving mode processes GPS positions in browser memory without saving a track. OpenStreetMap receives tile requests for viewed areas. Speech uses the device/browser speech service, which may use a remote voice provider. No map tiles are prefetched for offline use.
