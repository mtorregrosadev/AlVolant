# Local map assets

`run-local.sh` creates the local vector basemap without contacting an
AlVolant-controlled host. On first use it downloads the Catalunya extract from
[Geofabrik](https://download.geofabrik.de/) and builds a PMTiles archive with
[Planetiler](https://github.com/onthegomap/planetiler). The generated archive
and intermediate data live in ignored `.alvolant/maps/`.

The bundled style templates use the OpenMapTiles schema and retain OpenMapTiles
and OpenStreetMap attribution in the map. The included Noto Sans font files are
licensed under the SIL Open Font License, Version 1.1. See
<https://openfontlicense.org/>.

The style templates contain an `__MAP_ORIGIN__` placeholder. The runner replaces
it only in its ignored local copies, so the versioned templates never point to a
personal DNS name.
