/**
 * Fixtures shaped like real onX Web Map exports: a GPX with waypoints, a
 * track and a route, and a KML with nested folders, a point, a line and a
 * polygon.
 */

export const GPX_EXPORT = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="onX Maps" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>Hunt Markups</name></metadata>
  <wpt lat="46.8721000" lon="-114.0198000">
    <ele>1042.3</ele>
    <time>2025-09-14T13:05:00Z</time>
    <name>North Treestand</name>
    <desc>Good morning thermals &amp; clear shooting lane</desc>
    <sym>Tree Stand</sym>
  </wpt>
  <wpt lat="46.8690000" lon="-114.0250000">
    <ele>1015.0</ele>
    <name>Truck Parking</name>
    <sym>Parking</sym>
  </wpt>
  <wpt lat="200.0" lon="-114.0">
    <name>Corrupt Waypoint</name>
  </wpt>
  <rte>
    <name>Access Route</name>
    <desc>Gate to saddle</desc>
    <rtept lat="46.8690000" lon="-114.0250000"><ele>1015.0</ele></rtept>
    <rtept lat="46.8700000" lon="-114.0230000"><ele>1030.0</ele></rtept>
    <rtept lat="46.8710000" lon="-114.0210000"><ele>1048.0</ele></rtept>
  </rte>
  <trk>
    <name>Morning Scout</name>
    <desc>Walked the ridge</desc>
    <trkseg>
      <trkpt lat="46.8700000" lon="-114.0200000"><ele>1000.0</ele><time>2025-09-14T12:00:00Z</time></trkpt>
      <trkpt lat="46.8710000" lon="-114.0200000"><ele>1020.0</ele><time>2025-09-14T12:10:00Z</time></trkpt>
      <trkpt lat="46.8720000" lon="-114.0200000"><ele>1041.0</ele><time>2025-09-14T12:20:00Z</time></trkpt>
    </trkseg>
  </trk>
</gpx>
`;

export const KML_EXPORT = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>Elk 2025</name>
    <Folder>
      <name>Elk 2025</name>
      <Folder>
        <name>North Ridge</name>
        <Placemark>
          <name>Wallow</name>
          <description><![CDATA[Fresh sign <strong>Sept 12</strong>]]></description>
          <styleUrl>#onx-icon-water</styleUrl>
          <TimeStamp><when>2025-09-12T08:30:00Z</when></TimeStamp>
          <Point><coordinates>-114.0198000,46.8721000,1042.3</coordinates></Point>
        </Placemark>
        <Placemark>
          <name>Property Boundary</name>
          <Polygon>
            <outerBoundaryIs>
              <LinearRing>
                <coordinates>
                  -114.0300000,46.8700000,0 -114.0200000,46.8700000,0
                  -114.0200000,46.8760000,0 -114.0300000,46.8760000,0
                  -114.0300000,46.8700000,0
                </coordinates>
              </LinearRing>
            </outerBoundaryIs>
          </Polygon>
        </Placemark>
      </Folder>
      <Placemark>
        <name>Drainage Line</name>
        <LineString>
          <coordinates>-114.0250000,46.8690000,1015 -114.0230000,46.8700000,1030 -114.0210000,46.8710000,1048</coordinates>
        </LineString>
      </Placemark>
    </Folder>
    <Placemark>
      <name>Placemark With No Geometry</name>
    </Placemark>
  </Document>
</kml>
`;

/** A KML entity-expansion attempt; the parser must not resolve `&xxe;`. */
export const KML_WITH_DOCTYPE = `<?xml version="1.0"?>
<!DOCTYPE kml [
  <!ENTITY xxe SYSTEM "file:///etc/passwd">
]>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <Placemark>
      <name>&xxe;</name>
      <Point><coordinates>-114.02,46.87</coordinates></Point>
    </Placemark>
  </Document>
</kml>
`;
