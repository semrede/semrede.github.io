#!/bin/sh
# Refresh the satellite views on /locations.
# Imagery: Esri World Imagery (Esri, Maxar, Earthstar Geographics), used with
# attribution on the page. The files are stored in the repo so the page stays
# fast and keeps working behind content blockers.
set -e
cd "$(dirname "$0")/.."
base="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export"
# name|bbox lon,lat,lon,lat (WGS84), centred on the venue
for spec in \
  "eva|-8.378609,40.154142,-8.369609,40.158742" \
  "embaixada|-8.4327115,40.2088864,-8.4267115,40.2114864"
do
  name=${spec%%|*}
  bbox=${spec#*|}
  curl -sf --max-time 60 -o "img/map-$name.jpg" "$base?bbox=$bbox&bboxSR=4326&size=1000,562&format=jpg&f=image"
  echo "img/map-$name.jpg updated"
done
