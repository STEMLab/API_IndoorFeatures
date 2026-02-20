/* ---------- Basic Helpers ---------- */
export function safeStr(v){
  return (typeof v==="string") ? v : (typeof v==="number") ? String(v) : "";
}

export function deepFind(obj, predicate, maxDepth=6){
  const out=[], seen=new Set(), stack=[{v:obj,d:0}];
  while(stack.length){
    const {v,d}=stack.pop();
    if(!v || typeof v!=="object") continue;
    if(seen.has(v)) continue;
    seen.add(v);
    if(predicate(v)) out.push(v);
    if(d>=maxDepth) continue;
    if(Array.isArray(v)){
      for(let i=v.length-1;i>=0;i--) stack.push({v:v[i],d:d+1});
    } else {
      for(const k of Object.keys(v)) stack.push({v:v[k],d:d+1});
    }
  }
  return out;
}

/* ---------- IndoorGML Specific Iterators ---------- */
export function iterCellSpaces(obj) {
  const out = [];
  if (!obj || typeof obj !== "object") return out;

  // Standard members
  if (obj?.featureType === "CellSpace") out.push(obj);
  if (Array.isArray(obj.cellSpaceMember)) out.push(...obj.cellSpaceMember);
  if (Array.isArray(obj?.primalSpace?.cellSpaceMember)) out.push(...obj.primalSpace.cellSpaceMember);

  // Deep layers traversal (Found in PNU-style IndoorJSON)
  const layers = obj.layers || obj.indoorFeatures?.layers || [];
  for (const layer of layers) {
    const primal = layer.primalSpace || layer.primalSpaceLayer || layer.primal || {};
    const members = primal.cellSpaceMember || primal.cellSpaces || [];
    if (Array.isArray(members)) out.push(...members);
  }

  const seen = new Set(), dedup = [];
  for (const cs of out) {
    const id = cs?.id ? String(cs.id) : null;
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    dedup.push(cs);
  }
  return dedup;
}

export function iterDualNodes(obj) {
  return deepFind(obj, v => v?.featureType === "Node" && v?.geometry?.type === "Point", 9);
}

export function iterDualEdges(obj) {
  return deepFind(obj, v => v?.featureType === "Edge" && v?.geometry?.type === "LineString", 9);
}

/* ---------- Robust Triangulation (Concave-aware) ---------- */

export function polyhedronToTris(geom3d) {
  const tris = [], coords = geom3d?.coordinates;
  if (!Array.isArray(coords)) return tris;

  // Handle different nesting levels of Polyhedron coordinates
  const polys = (Array.isArray(coords[0][0][0])) ? coords : [coords];

  for (const poly of polys) {
    for (const face of poly) {
      // Extract the outer ring of the face
      let ring = Array.isArray(face[0]) && Array.isArray(face[0][0]) ? face[0] : face;
      if (!Array.isArray(ring) || ring.length < 3) continue;

      const pts = ring.map(p => [p[0], p[1], p[2] ?? 0]);
      tris.push(...triangulateRing(pts));
    }
  }
  return tris;
}

function triangulateRing(pts) {
  if (!Array.isArray(pts) || pts.length < 3) return [];

  // 1. Remove closure point if it's a duplicate of the first point
  const first = pts[0], last = pts[pts.length - 1];
  if (first[0] === last[0] && first[1] === last[1] && (first[2] ?? 0) === (last[2] ?? 0)) {
    pts = pts.slice(0, -1);
  }
  if (pts.length < 3) return [];

  // 2. Find the face normal to create a 2D projection plane
  let n = null, p0 = pts[0];
  for (let i = 0; i < pts.length - 2; i++) {
    const A = pts[i], B = pts[i + 1], C = pts[i + 2];
    const ab = [B[0] - A[0], B[1] - A[1], (B[2] ?? 0) - (A[2] ?? 0)];
    const ac = [C[0] - A[0], C[1] - A[1], (C[2] ?? 0) - (A[2] ?? 0)];
    const cross = [
      ab[1] * ac[2] - ab[2] * ac[1],
      ab[2] * ac[0] - ab[0] * ac[2],
      ab[0] * ac[1] - ab[1] * ac[0]
    ];
    const len = Math.hypot(...cross);
    if (len > 1e-9) {
      n = cross.map(v => v / len);
      p0 = A;
      break;
    }
  }

  // Fallback if normal calculation fails (degenerate face)
  if (!n) {
    const tris = [];
    for (let i = 1; i < pts.length - 1; i++) tris.push([pts[0], pts[i], pts[i + 1]]);
    return tris;
  }

  // 3. Build an orthonormal basis (u, v) on the face plane
  const ref = (Math.abs(n[2]) < 0.9) ? [0, 0, 1] : [0, 1, 0];
  let u = [n[1] * ref[2] - n[2] * ref[1], n[2] * ref[0] - n[0] * ref[2], n[0] * ref[1] - n[1] * ref[0]];
  const ulen = Math.hypot(...u);
  u = u.map(v => v / ulen);
  const v = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];

  // 4. Project to 2D for Earcut
  const coords2d = [];
  for (const P of pts) {
    const px = P[0] - p0[0], py = P[1] - p0[1], pz = (P[2] ?? 0) - (p0[2] ?? 0);
    coords2d.push(px * u[0] + py * u[1] + pz * u[2], px * v[0] + py * v[1] + pz * v[2]);
  }

  // 5. Run Earcut and map back to 3D
  const earcut = window.earcut || (typeof earcut !== 'undefined' ? earcut : null);
  if (!earcut) return []; // Should not happen given your HTML

  const idx = earcut(coords2d, null, 2);
  const tris = [];
  for (let t = 0; t < idx.length; t += 3) {
    tris.push([pts[idx[t]], pts[idx[t + 1]], pts[idx[t + 2]]]);
  }
  return tris;
}

/* ---------- 2D Helpers & Bounding Boxes ---------- */

/**
 * Converts IndoorGML 2D geometry into a set of rings (arrays of points).
 */
export function polygon2dToRings(geom2d) {
  const type = geom2d?.type || geom2d?.Geometry2D?.type;
  const coords = geom2d?.coordinates || geom2d?.Geometry2D?.coordinates;
  if (!coords) return [];
  
  if (type === "Polygon") return coords;
  if (type === "MultiPolygon") return coords.flatMap(poly => poly);
  return [];
}

/**
 * This is the magic function that prevents the "overlapping" and "connecting" line mess.
 * It forces Plotly to lift the pen between rings.
 */
export function pushRingPairs(pairs, ring) {
  if (!Array.isArray(ring) || ring.length < 2) return;
  
  const pts = ring.slice();
  const a = pts[0], b = pts[pts.length - 1];
  
  // 1. Close the ring if the data hasn't already
  if (!(a[0] === b[0] && a[1] === b[1])) {
    pts.push(a);
  }

  // 2. Push points to the flat array
  for (const p of pts) {
    pairs.push([p[0], p[1]]);
  }

  // 3. THE FIX: Add a null break so Plotly doesn't connect this room to the next
  pairs.push([null, null]);
}

export function bboxFromPoints(points) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p[0]); minY = Math.min(minY, p[1]);
    maxX = Math.max(maxX, p[0]); maxY = Math.max(maxY, p[1]);
  }
  return Number.isFinite(minX) ? { min: [minX, minY], max: [maxX, maxY] } : null;
}

export function computeLevelZ(indoorjson){
  // level -> array of observed base-z values (one per CellSpace)
  const zByLevel = new Map();

  // Helper: walk nested arrays and collect [x,y,z] triples
  function collectZFromPolyhedronCoordinates(coords, out){
    // coords shape in your example:
    // Polyhedron -> [ [ face1, face2, ... ] ]
    // face -> [ [x,y,z], [x,y,z], ... ]
    if(!Array.isArray(coords)) return;

    // Generic deep walk: when we see a triplet of numbers, treat as vertex
    const stack = [coords];
    while(stack.length){
      const cur = stack.pop();
      if(!Array.isArray(cur)) continue;

      if(cur.length === 3 &&
         typeof cur[0] === "number" &&
         typeof cur[1] === "number" &&
         typeof cur[2] === "number"){
        out.push(cur[2]);
        continue;
      }
      for(let i=0;i<cur.length;i++) stack.push(cur[i]);
    }
  }

  // Your file already has iterCellSpaces(); reuse it if available.
  // Otherwise, use a conservative fallback via deepFind.
  const cellSpaces = (typeof iterCellSpaces === "function")
    ? Array.from(iterCellSpaces(indoorjson))
    : (function fallback(){
        const found = [];
        (function walk(o){
          if(!o || typeof o !== "object") return;
          if(o.featureType === "CellSpace") found.push(o);
          for(const k in o) walk(o[k]);
        })(indoorjson);
        return found;
      })();

  for(const cs of cellSpaces){
    const level = cs.level != null ? String(cs.level) : null;
    if(!level) continue;

    const g3 = cs?.cellSpaceGeom?.geometry3D;
    const coords = g3?.coordinates;
    if(!coords) continue;

    const zVals = [];
    collectZFromPolyhedronCoordinates(coords, zVals);
    if(!zVals.length) continue;

    // Base floor z for this cell (robust for your "0..20" extrusion example)
    const baseZ = Math.min(...zVals);

    if(!zByLevel.has(level)) zByLevel.set(level, []);
    zByLevel.get(level).push(baseZ);
  }

  // median helper
  function median(arr){
    const a = arr.slice().sort((x,y)=>x-y);
    const n = a.length;
    if(n === 0) return null;
    const mid = Math.floor(n/2);
    return (n % 2) ? a[mid] : (a[mid-1] + a[mid]) / 2;
  }

  // Build levelZ
  const levelZ = {};
  const levelsSorted = Array.from(zByLevel.keys()).sort((a,b)=>Number(a)-Number(b));

  for(const lvl of levelsSorted){
    const m = median(zByLevel.get(lvl));
    if(m != null) levelZ[lvl] = m;
  }

  // Typical spacing (median delta between consecutive levelZs)
  const zList = levelsSorted.map(lvl => levelZ[lvl]).filter(z => typeof z === "number");
  const deltas = [];
  for(let i=1;i<zList.length;i++){
    deltas.push(Math.abs(zList[i] - zList[i-1]));
  }
  const levelSpacing = deltas.length ? median(deltas) : null;

  return { levelZ, levelSpacing };
}

function makeSnapper(levelZ){
  const levels = Object.keys(levelZ);
  // Precompute for speed
  const levelItems = levels
    .map(lvl => ({ lvl: String(lvl), z: Number(levelZ[lvl]) }))
    .filter(o => Number.isFinite(o.z));

  // Typical spacing for tolerance (median delta)
  const zs = levelItems.map(o => o.z).sort((a,b)=>a-b);
  const deltas = [];
  for(let i=1;i<zs.length;i++) deltas.push(Math.abs(zs[i]-zs[i-1]));
  deltas.sort((a,b)=>a-b);
  const median = (arr)=> arr.length
    ? (arr.length%2 ? arr[(arr.length-1)/2] : (arr[arr.length/2-1]+arr[arr.length/2])/2)
    : null;
  const spacing = median(deltas);

  // If spacing exists, allow some tolerance; else very small tolerance.
  const tol = spacing != null ? spacing * 0.45 : 1e-6;

  function snapZToLevel(z){
    if(!Number.isFinite(z) || levelItems.length === 0) return { level: null, dist: Infinity };

    let best = null;
    let bestD = Infinity;
    for(const it of levelItems){
      const d = Math.abs(z - it.z);
      if(d < bestD){
        bestD = d;
        best = it.lvl;
      }
    }
    // If it's too far from any known levelZ, mark unknown
    if(bestD > tol) return { level: null, dist: bestD };
    return { level: best, dist: bestD };
  }

  return { snapZToLevel, tol, spacing };
}

export function bucketDualNodesByLevel(indoorjson, levelZ){
  const { snapZToLevel } = makeSnapper(levelZ);

  const byLevel = {};   // level -> array of nodes
  const nodeLevel = new Map(); // nodeId -> level (string|null)

  const nodes = (typeof iterDualNodes === "function")
    ? Array.from(iterDualNodes(indoorjson))
    : [];

  for(const n of nodes){
    const c = n?.geometry?.coordinates;
    const z = Array.isArray(c) && c.length >= 3 ? Number(c[2]) : NaN;

    const { level } = snapZToLevel(z);
    nodeLevel.set(n.id, level);

    // keep it on the object too (optional but convenient)
    n.__level = level;

    if(level != null){
      (byLevel[level] ||= []).push(n);
    }
  }

  return { dualNodesByLevel: byLevel, nodeLevel };
}

export function bucketDualEdgesByLevel(indoorjson, levelZ){
  const { snapZToLevel } = makeSnapper(levelZ);

  const byLevel = {};        // level -> array of edges (intra-level)
  const interLevel = [];     // edges connecting different levels
  const edgeLevels = new Map(); // edgeId -> {aLevel,bLevel}

  const edges = (typeof iterDualEdges === "function")
    ? Array.from(iterDualEdges(indoorjson))
    : [];

  for(const e of edges){
    const coords = e?.geometry?.coordinates;

    // Determine endpoint z's
    let zA = NaN, zB = NaN;
    if(e?.geometry?.type === "LineString" && Array.isArray(coords) && coords.length >= 2){
      const a = coords[0];
      const b = coords[coords.length - 1];
      zA = Array.isArray(a) && a.length >= 3 ? Number(a[2]) : NaN;
      zB = Array.isArray(b) && b.length >= 3 ? Number(b[2]) : NaN;
    }

    const aSnap = snapZToLevel(zA);
    const bSnap = snapZToLevel(zB);

    edgeLevels.set(e.id, { aLevel: aSnap.level, bLevel: bSnap.level });

    // Store for convenience
    e.__aLevel = aSnap.level;
    e.__bLevel = bSnap.level;

    if(aSnap.level != null && aSnap.level === bSnap.level){
      (byLevel[aSnap.level] ||= []).push(e);
      e.__level = aSnap.level;
    } else {
      interLevel.push(e);
      e.__level = null;
    }
  }

  return { dualEdgesByLevel: byLevel, interLevelEdges: interLevel, edgeLevels };
}

export function route2DForLevel(routePoints, levelZ, targetLevel){
  // Returns {xs, ys} for Plotly scattergl lines, with null breaks between levels/segments.
  const { snapZToLevel } = makeSnapper(levelZ);

  const xs = [], ys = [];
  let drawing = false;

  const pushBreak = () => {
    if (drawing){
      xs.push(null); ys.push(null);
      drawing = false;
    }
  };

  for (const p of routePoints || []){
    if (!p || p[0] === null){ // existing break from stitched routes
      pushBreak();
      continue;
    }

    const z = Number.isFinite(p[2]) ? p[2] : 0;
    const { level } = snapZToLevel(z);

    const ok = (targetLevel === "__all__") || (level === targetLevel);

    if (ok){
      xs.push(p[0]);
      ys.push(p[1]);
      drawing = true;
    } else {
      // crossed into another level: break the polyline
      pushBreak();
    }
  }

  // trailing break not required, but fine either way
  return { xs, ys };
}