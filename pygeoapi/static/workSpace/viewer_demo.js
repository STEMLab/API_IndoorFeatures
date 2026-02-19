import {
  safeStr,
  iterCellSpaces,
  iterDualNodes,
  iterDualEdges,
  polygon2dToRings,
  polyhedronToTris,
  bboxFromPoints,
  pushRingPairs,
  computeLevelZ,
  bucketDualEdgesByLevel,
  bucketDualNodesByLevel,
  route2DForLevel
} from "./geometry.js";

import * as api from './api.js';

// Global State
let MODEL = null;
let ROUTE = null;
let CURRENT_LEVEL = "__all__";
let CURRENT_MODE = "2d";
let SHOW_DUAL = false;
let SHOW_ROUTE = true;
let selectedCollectionId = null;
let selectedFeatureId = null;
let selectedFeatureData = null; // Store the fetched GeoJSON here
let routeResult = null;
let connResult = null;
let selectedLayerId = null;
let selectedFeatureDataAll = null;
let selectedDualMemberId = null;

const plot3d = document.getElementById("plot3d");
const plot2d = document.getElementById("plot2d");
const cursorDiv = document.getElementById("cursor");
const selectionDiv = document.getElementById("sel");
const levelSelect = document.getElementById("level");
const btn3d = document.getElementById("btn3d");
const btn2d = document.getElementById("btn2d");
const toggleDual = document.getElementById("toggleDual");

/* ---------- Build Model ---------- */

function buildBaseModel(indoorjson) {
  const cells = iterCellSpaces(indoorjson);
  const levels = new Set();
  const byLevel3d = new Map();
  const byLevel2d = new Map();
  const layers = indoorjson.layers || indoorjson.indoorFeatures?.layers || [];
  const thematicLayerCount = Array.isArray(layers) ? layers.length : 0;
  const nodes = iterDualNodes(indoorjson);
  const edges = iterDualEdges(indoorjson);

  const addLevel = (lvl) => {
    levels.add(lvl);
    if (!byLevel3d.has(lvl)) byLevel3d.set(lvl, { x: [], y: [], z: [], i: [], j: [], k: [] });
    if (!byLevel2d.has(lvl)) byLevel2d.set(lvl, { pairs: [], ids: [] }); // Fixed: Ensure ids exist
  };

  for (const cs of cells) {
    const lvl = safeStr(cs.level) || safeStr(cs.storey) || "UNKNOWN";
    addLevel(lvl);

    const geom = cs.cellSpaceGeom || cs.CellSpaceGeom || {};
    const g3 = geom.geometry3D || null;
    const g2 = geom.geometry2D || null;

    if (g3 && g3.type === "Polyhedron") {
      const tris = polyhedronToTris(g3);
      const store = byLevel3d.get(lvl);
      for (const tri of tris) {
        const base = store.x.length;
        for (const p of tri) {
          store.x.push(p[0]); store.y.push(p[1]); store.z.push(p[2] ?? 0);
        }
        store.i.push(base); store.j.push(base + 1); store.k.push(base + 2);
      }
    }

    const store2 = byLevel2d.get(lvl);
    if (g2 && (g2.type === "Polygon" || g2.type === "MultiPolygon")) {
      const rings = polygon2dToRings(g2);
      // Ensure every vertex in the ring gets the ID assigned to it
      for (const ring of rings) {
        pushRingPairs(store2.pairs, ring); 
        ring.forEach(() => {
          store2.ids.push(cs.id); // Push ID for every coordinate
        });
        store2.ids.push(null); // Push null to match the gap in pairs
      }
    } else if (g3 && g3.type === "Polyhedron") {
      const tris = polyhedronToTris(g3);
      const pts = tris.flat();
      const bb = bboxFromPoints(pts);
      if (bb) {
        const [x0, y0] = bb.min; const [x1, y1] = bb.max;
        const ring = [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
        pushRingPairs(store2.pairs, ring);
        ring.forEach(() => store2.ids.push(cs.id));
        store2.ids.push(null);
      }
    }
  }

  return {
    _src: indoorjson,
    levels: Array.from(levels).sort(),
    byLevel3d,
    byLevel2d,
    dualNodes: nodes,
    dualEdges: edges,
    stats: { thematicLayers: thematicLayerCount, cellSpaces: cells.length, nodes: nodes.length, edges: edges.length }
  };
}

function buildRoute(obj, stitch){
  // returns {points:[[x,y,z] or null breaks], source:"...", count:int, segments:[...]}
  // stitch=false: trust route order/direction (directed graph outputs)
  // stitch=true: auto-orient segments + insert breaks (good for undirected/unordered)

  // 1) Your API: {type:"RouteResult", path_segments:[{geometry:{...}}, ...]}
  if (obj && typeof obj === "object" && (obj.type === "RouteResult") && Array.isArray(obj.path_segments)) {
    const segments = [];
    const normPt = (p) => [p[0], p[1], (p.length>=3 ? p[2] : 0)];

    if (!stitch) {
      const pts = [];
      for (const seg of obj.path_segments){
        const g = seg?.geometry;
        if (!g || !g.type || !Array.isArray(g.coordinates)) continue;

        let segPts = [];
        if (g.type === "LineString") segPts = g.coordinates.map(normPt);
        else if (g.type === "MultiLineString") segPts = g.coordinates.flat().map(normPt);
        else if (g.type === "Point") segPts = [normPt(g.coordinates)];
        else if (g.type === "MultiPoint") segPts = g.coordinates.map(normPt);
        else continue;

        if (!segPts.length) continue;
        pts.push(...segPts);

        segments.push({
          seq: seg?.seq ?? null,
          id_str: seg?.id_str ?? null,
          type: seg?.type ?? null,
          cost: seg?.cost ?? null,
          start: segPts[0],
          end: segPts[segPts.length-1]
        });
      }
      if (pts.length) return {points: pts, segments, source:"RouteResult.path_segments", count: pts.length};
    } else {
      const pts = [];
      let cursor = null;
      const EPS = 1e-6;

      const dist2 = (a,b) => {
        const dx=(a[0]-b[0]), dy=(a[1]-b[1]), dz=((a[2]??0)-(b[2]??0));
        return dx*dx+dy*dy+dz*dz;
      };
      const same = (a,b) => dist2(a,b) <= EPS;

      const pushBreak = () => {
        if (pts.length && (pts[pts.length-1][0] !== null)) pts.push([null,null,null]);
        cursor = null;
      };

      for (const seg of obj.path_segments){
        const g = seg?.geometry;
        if (!g || !g.type || !Array.isArray(g.coordinates)) continue;

        let segPts = [];
        if (g.type === "LineString") segPts = g.coordinates.slice();
        else if (g.type === "MultiLineString") segPts = g.coordinates.flat();
        else if (g.type === "Point") segPts = [g.coordinates];
        else if (g.type === "MultiPoint") segPts = g.coordinates.slice();
        else continue;

        if (!segPts.length) continue;
        segPts = segPts.map(normPt);

        if (segPts.length >= 2 && cursor) {
          const dStart = dist2(cursor, segPts[0]);
          const dEnd   = dist2(cursor, segPts[segPts.length-1]);
          if (dEnd < dStart) segPts.reverse();
        }

        if (cursor && !same(cursor, segPts[0])) pushBreak();
        if (cursor && same(cursor, segPts[0])) segPts = segPts.slice(1);
        if (!segPts.length) continue;

        const segStart = segPts[0];
        const segEnd = segPts[segPts.length-1];

        for (const p of segPts) pts.push(p);

        segments.push({
          seq: seg?.seq ?? null,
          id_str: seg?.id_str ?? null,
          type: seg?.type ?? null,
          cost: seg?.cost ?? null,
          start: segStart,
          end: segEnd
        });

        cursor = pts.length ? pts[pts.length-1] : null;
        if (cursor && cursor[0] === null) cursor = null;
      }

      while (pts.length && pts[pts.length-1][0] === null) pts.pop();
      const count = pts.filter(p=>p[0]!==null).length;
      if (count) return {points: pts, segments, source:"RouteResult.path_segments(stitched)", count};
    }
    return {points: [], segments: [], source:"RouteResult(empty)", count: 0};
  }
}

/* ---------- Rendering ---------- */

function renderAll() {
  if (!MODEL) return;

  // Sync Level Dropdown
  const sel = document.getElementById("level");
  const currentVal = sel.value; // Save selection if possible
  sel.innerHTML = '<option value="__all__">All</option>';
  MODEL.levels.forEach(lvl => {
    const o = document.createElement("option");
    o.value = lvl; o.textContent = lvl; sel.appendChild(o);
  });
  if (MODEL.levels.includes(currentVal)) sel.value = currentVal;
  
  render3D();
  render2D();
  // const gd = getActivePlotEl();
  // console.log(gd);
  // if (gd && gd.data) Plotly.Plots.resize(gd);
}

function render3D() {
  const traces = [];
  let zMin = -Infinity, zMax = Infinity;

  if (CURRENT_LEVEL !== "__all__") {
    const base = MODEL.byLevel3d.get(CURRENT_LEVEL);
    if (base && base.z.length > 0) {
      const validZ = base.z.filter(v => v !== null && v !== undefined);
      zMin = Math.min(...validZ) - 0.1;
      zMax = Math.max(...validZ);
    }
  }

  for (const [lvl, s] of MODEL.byLevel3d.entries()) {
    if (!s || !s.i.length) continue;
    traces.push({
      type: "mesh3d", name: lvl, x: s.x, y: s.y, z: s.z, i: s.i, j: s.j, k: s.k,
      opacity: 0.5, hoverinfo: "name", visible: (CURRENT_LEVEL === "__all__" || CURRENT_LEVEL === lvl)
    });
  }

  if (SHOW_DUAL && MODEL.dualNodes && MODEL.dualEdges) {
    const nx = [], ny = [], nz = [];
    const ex = [], ey = [], ez = [];

    MODEL.dualNodes.forEach(n => {
      const p = n.geometry.coordinates;
      const z = p[2] || 0;
      if (CURRENT_LEVEL === "__all__" || (z >= zMin && z < zMax)) {
        nx.push(p[0]); ny.push(p[1]); nz.push(z);
      }
    });

    MODEL.dualEdges.forEach(edge => {
      const coords = edge.geometry.coordinates;
      if (!Array.isArray(coords) || coords.length < 2) return;
      const isInRange = CURRENT_LEVEL === "__all__" || coords.some(p => {
        const z = p[2] || 0;
        return z >= zMin && z < zMax;
      });
      if (isInRange) {
        for (const p of coords) {
          ex.push(p[0]); ey.push(p[1]); ez.push(p[2] || 0);
        }
        ex.push(null); ey.push(null); ez.push(null);
      }
    });

    if (nx.length) traces.push({ type: "scatter3d", mode: "markers", name: "Nodes", x: nx, y: ny, z: nz, marker: { size: 4, color: "#f1c40f" } });
    if (ex.length) traces.push({ type: "scatter3d", mode: "lines", name: "Edges", x: ex, y: ey, z: ez, line: { color: "#e74c3c", width: 3 } });
  }
  if(ROUTE&&ROUTE.points&&ROUTE.points.length>=2){
    const xs=ROUTE.points.map(p=>p[0]), ys=ROUTE.points.map(p=>p[1]), zs=ROUTE.points.map(p=>p[2]);
    var nodeColors = [];
    for (var i = 0; i < xs.length; i++) {
      if (i === 0) {
          nodeColors.push("green");           // First Node (Start)
      } else if (i === xs.length - 1) {
          nodeColors.push("red");         // Last Node (Destination)
      } else {
          nodeColors.push("rgba(0,90,255,0)"); // Middle Nodes (Path)
      }
    }
    traces.push({type:"scatter3d",mode:"lines+markers",name:"ROUTE",x:xs,y:ys,z:zs,line:{width:5,color:"rgba(0,90,255,0.95)"},marker:{size:4,color:nodeColors},hoverinfo:"skip",visible:SHOW_ROUTE,meta:{role:"route",level:"__all__"}});
  }

  Plotly.newPlot(plot3d, traces, { margin: { l: 0, r: 0, t: 30, b: 0 }, scene: { aspectmode: "data" } });
}

function render2D() {
  if (!MODEL) return;
  const traces = [];

  for (const lvl of MODEL.levels) {
    const s = MODEL.byLevel2d.get(lvl);
    if (!s || !s.pairs.length) continue;
    traces.push({
      type: "scattergl", mode: "lines", name: `LEVEL_${lvl}`, x: s.pairs.map(p => p[0]), y: s.pairs.map(p => p[1]),
      customdata: s.ids, line: { width: 1, color: "#333333", simplify: false },
      hoverinfo: "all", visible: (CURRENT_LEVEL === "__all__" || CURRENT_LEVEL === lvl)
    });
  }
  if (SHOW_DUAL && MODEL.dualEdgesByLevel){
    for (const [lvl, edges] of Object.entries(MODEL.dualEdgesByLevel)){
      if(!edges || !edges.length) continue;

      const ex=[], ey=[];
      for(const e of edges){
        const coords = e?.geometry?.coordinates;
        if(!Array.isArray(coords) || coords.length < 2) continue;

        for(const p of coords){
          if(!Array.isArray(p) || p.length < 2) continue;
          ex.push(p[0]); ey.push(p[1]);
        }
        ex.push(null); ey.push(null); // break between edges
      }
      if(!ex.length) continue;

      traces.push({
        type:"scattergl",
        mode:"lines",
        name:`DUAL_EDGES_${lvl}`,
        x:ex, y:ey,
        line:{width:2, color:"rgba(255,120,0,0.65)"},
        hoverinfo:"skip",
        visible:(CURRENT_LEVEL==="__all__" || CURRENT_LEVEL===lvl),
        meta:{role:"dual", level:lvl, kind:"edge"}
      });
    }
  }

  if (SHOW_DUAL && MODEL.dualNodesByLevel){
    for (const [lvl, nodes] of Object.entries(MODEL.dualNodesByLevel)){
      if(!nodes || !nodes.length) continue;

      const nx=[], ny=[], hover=[];
      for(const n of nodes){
        const c = n?.geometry?.coordinates;
        if(!Array.isArray(c) || c.length < 2) continue;
        nx.push(c[0]); ny.push(c[1]);
        hover.push(`Node ${n.id ?? ""}${n.duality ? ` (duality ${n.duality})` : ""} z=${c[2] ?? ""}`);
      }
      if(!nx.length) continue;

      traces.push({
        type:"scattergl",
        mode:"markers",
        name:`DUAL_NODES_${lvl}`,
        x:nx, y:ny,
        marker:{size:8, color:"rgba(255,120,0,0.95)"},
        hovertext:hover, hoverinfo:"text",
        visible:(CURRENT_LEVEL==="__all__" || CURRENT_LEVEL===lvl),
        meta:{role:"dual", level:lvl, kind:"node"}
      });
    }
  }
  if(ROUTE && ROUTE.points && ROUTE.points.length >= 2){
    const { xs, ys } = route2DForLevel(
      ROUTE.points,
      MODEL.levelZ || {},
      CURRENT_LEVEL
    );

    // Only draw if there is something on this level (or __all__)
    const hasAny = xs.some(v => v !== null && v !== undefined);
    if(hasAny){
      var nodeColors = [];
      for (var i = 0; i < xs.length; i++) {
        if (i === 0) {
            nodeColors.push("green");           // First Node (Start)
        } else if (i === xs.length - 1) {
            nodeColors.push("red");         // Last Node (Destination)
        } else {
            nodeColors.push("rgba(0,90,255,0)"); // Middle Nodes (Path)
        }
      }

      traces.push({
        type:"scattergl",
        mode:"lines+markers",
        name:"ROUTE",
        x: xs,
        y: ys,
        line:{width:3,color:"rgba(0,90,255,0.95)"},
        marker:{size:5,color:nodeColors},
        hoverinfo:"skip",
        visible:SHOW_ROUTE,
        meta:{role:"route",level:"__all__"} // route is global; filtering is baked into x/y
      });
    }
  }
  const layout = {
    xaxis: { scaleanchor: "y", zeroline: false, constrain: "domain" },
    yaxis: { zeroline: false },
    margin: { l: 40, r: 10, t: 30, b: 40 },
    hovermode: 'closest' // Crucial for clicking thin lines accurately
  };

  Plotly.newPlot(plot2d, traces, layout);
}

/* ---------- Events ---------- */

// This listener handles clicks ANYWHERE on the 2D plot
plot2d.addEventListener('click', function(e) {
  if (!plot2d._fullLayout || !plot2d._fullLayout.xaxis) return;

  const fullLayout = plot2d._fullLayout;
  // Convert pixel click (offsetX/Y) to data coordinates (x/y)
  const x = fullLayout.xaxis.p2c(e.offsetX);
  const y = fullLayout.yaxis.p2c(e.offsetY);

  // --- ROOM SEARCH LOGIC ---
  let clickedId = "Outside / No Room";
  
  // If you want to find which room was clicked, we can check the MODEL
  if (MODEL) {
    clickedId = findRoomAtCoords(x, y);
  }

  const selectionInfo = {
    "selection": {
      "id": clickedId,
      "level": CURRENT_LEVEL === "__all__" ? "Multiple" : CURRENT_LEVEL,
    },
    "cursor": {
      "x": x,
      "y": y
    }
  };

  selectionDiv.textContent = JSON.stringify(selectionInfo, null, 2);
});

// Helper function to check which room contains the point (Point-in-Polygon)
function findRoomAtCoords(x, y) {
  // We can iterate through the current level's 2D polygons
  // For now, let's look at the IDs we stored in buildBaseModel
  // This is a simplified check; a true 'contains' check requires a geometric library
  return "Detected at " + CURRENT_LEVEL; 
}

plot2d.addEventListener('mousemove', function(e) {
  if (!plot2d._fullLayout || !plot2d._fullLayout.xaxis) return;
  const x = plot2d._fullLayout.xaxis.p2c(e.offsetX);
  const y = plot2d._fullLayout.yaxis.p2c(e.offsetY);
  cursorDiv.textContent = `X: ${x.toFixed(2)}\nY: ${y.toFixed(2)}`;
});

function getActivePlotEl() {
  return (CURRENT_MODE === "3d") ? plot3d : plot2d;
}

function activatePlot(mode){
  CURRENT_MODE = mode;

  // Toggle buttons
  btn3d.classList.toggle("active", mode === "3d");
  btn2d.classList.toggle("active", mode === "2d");

  // Toggle plot panels via class (NOT style.display)
  plot3d.classList.toggle("active", CURRENT_MODE === "3d");
  plot2d.classList.toggle("active", CURRENT_MODE === "2d");

  // Resize the now-visible plot (fixes downsized view)
  const gd = getActivePlotEl();
  if (gd && gd.data) {
    Plotly.Plots.resize(gd);
  }

  // Optional: keep view fitted
  fitView();
}

function fitView(){
  const gd = getActivePlotEl();
  if(!gd) return;

  if (CURRENT_MODE === "3d"){
    Plotly.relayout(gd, {"scene.camera": null});
  } else {
    Plotly.relayout(gd, {"xaxis.autorange": true, "yaxis.autorange": true});
  }
}


/* ---------- UI Toggles ---------- */

function setMode(mode) {
  activatePlot(mode);
}

btn3d.addEventListener("click", () => setMode("3d"));
btn2d.addEventListener("click", () => setMode("2d"));

levelSelect.addEventListener("change", (e) => {
  CURRENT_LEVEL = e.target.value;
  if (MODEL) renderAll();
});

toggleDual.addEventListener("change", (e) => {
  SHOW_DUAL = e.target.checked;
  if (MODEL) renderAll();
});

/* ---------- pygeoAPI Explorer Logic ---------- */

const dbList = document.getElementById("db-list");
const apiLog = document.getElementById("api-log");
const apiBack = document.getElementById("api-back");
const apiStatus = document.getElementById("api-status-right");
const initialDiv = document.querySelector('.initial');
const featureDiv = document.querySelector('.feature');
const selectedFeatureDiv = document.querySelector('.selectedFeature');
const statusDivs = document.querySelectorAll('.status');
const serviceBtn = document.getElementById("indoorFeature-service-button");
const searchDiv = document.querySelector('.search');
const routeDiv = document.querySelector('.route');
const viewDiv = document.querySelector('.view');
const vizStatus = document.getElementById("viz-status");

// 1. Get Collections Handler
document.getElementById("api-get-collections").addEventListener("click", async () => {
  try {
    apiStatus.textContent = "Fetching catalogs...";
    statusDivs.forEach(div => {
      div.innerText = "";
    })
    console.log(statusDivs);
    featureDiv.classList.add('hidden');
    selectedFeatureDiv.classList.add('hidden');
 
    const data = await api.getIndoorCollections();
    
    renderCollections(data.filtered);
    apiLog.textContent = JSON.stringify(data.raw, null, 2);
  } catch (err) {
    apiLog.textContent = "Error: " + err.message;
  }
});

// 2. Render Collections (UI Creation)
function renderCollections(collections) {
  dbList.innerHTML = "";
  collections.forEach(col => {
    const itemsLink = col.links.find(l => l.rel === "items" && l.type === "application/geo+json");
    const btn = document.createElement("button");
    btn.className = "db-item-btn";
    btn.innerHTML = `<strong>🏢 ${col.title}</strong><small>ID: ${col.id}</small>`;
    
    btn.onclick = async () => {
      // UI feedback
      document.querySelectorAll('.db-item-btn').forEach(b => b.style.border = "1px solid #ccc");
      btn.style.border = "2px solid #007bff"; 
      
      selectedCollectionId = col.id;
      document.getElementById("collection-post-target-name").innerText = col.title;
      featureDiv.classList.remove('hidden');
      // Call API
      try {
        apiStatus.textContent = `Listing items in ${col.id}...`;
        const featureCollection = await api.getCollectionItems(itemsLink.href);
        renderFeatures(featureCollection.features || [], col.id);
        apiLog.textContent = JSON.stringify(featureCollection, null, 2);
      } catch (err) {
        apiLog.textContent = "Error: " + err.message;
      }
    };
    dbList.appendChild(btn);
  });
}

// 3. POST Button Handler
document.getElementById("indoorFeature-upload-button").addEventListener("click", async () => {
  const fileInput = document.getElementById("file-input");
  const statusDiv = document.getElementById("indoorFeature-upload-status");

  if (!selectedCollectionId || fileInput.files.length === 0) {
    statusDiv.innerHTML = "<span style='color:red;'>❌ Missing selection or file.</span>";
    return;
  }

  try {
    const fileText = await fileInput.files[0].text();
    const jsonData = JSON.parse(fileText);
    statusDiv.innerText = "📤 Uploading...";

    const result = await api.postIndoorFeature(selectedCollectionId, jsonData);
    
    statusDiv.innerHTML = "<span style='color:green;'>✅ Success!</span>";
    apiLog.textContent = JSON.stringify(result, null, 2);
  } catch (err) {
    statusDiv.innerHTML = `<span style='color:red;'>❌ ${err.message}</span>`;
  }
});

// 4. Render Features & Fetch Single
function renderFeatures(features, colId) {
  dbList.innerHTML = "";
  features.forEach(f => {
    const btn = document.createElement("button");
    btn.className = "db-item-btn";
    btn.innerHTML = `<strong>📍 ${f.id || "Unnamed"}</strong>`;
    
    dbList.appendChild(btn);
    btn.onclick = async () => {
      // 1. UI Feedback: Highlight selection
      document.querySelectorAll('.db-item-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      
      // 2. Set IDs for Delete and Post steps
      selectedFeatureId = f.id;
      selectedFeatureDiv.classList.remove('hidden');
 
      document.getElementById("indoorFeature-delete-target-name").innerText = f.id;
      // Inside your renderFeatures function (right sidebar click):
      selectedLayerId = null;

      try {
        apiStatus.textContent = `Fetching ${f.id} data...`;
        // Fetch the data and store it globally
        selectedFeatureData = await api.getSingleFeature(colId, f.id);

        apiLog.textContent = JSON.stringify(selectedFeatureData, null, 2);
        apiStatus.textContent = `Selected: ${f.id}. Click 'Search' to view.`;
        
      } catch (err) {
        apiLog.textContent = "Error fetching feature: " + err.message;
      }
    };
   
  });
}

// DELETE BUTTON HANDLER
document.getElementById("indoorFeature-delete-button").addEventListener("click", async () => {
  const statusDiv = document.getElementById("indoorFeature-delete-status");

  if (!selectedCollectionId || !selectedFeatureId) {
    statusDiv.innerHTML = "<span style='color:red;'>❌ Select a collection AND a feature first.</span>";
    return;
  }

  const confirmDelete = confirm(`Are you sure you want to permanently delete feature: ${selectedFeatureId}? This will remove all associated layers.`);
  
  if (confirmDelete) {
    try {
      statusDiv.innerText = "🗑️ Deleting...";
      await api.deleteIndoorFeature(selectedCollectionId, selectedFeatureId);
      
      statusDiv.innerHTML = "<span style='color:green;'>✅ Deleted successfully.</span>";
      
      // Reset UI
      document.getElementById("indoorFeature-delete-target-name").innerText = "None";
      selectedFeatureId = null;
      
      // Optional: Refresh the list so the deleted item disappears
      // You can trigger the collection click again or clear the list
    } catch (err) {
      statusDiv.innerHTML = `<span style='color:red;'>❌ ${err.message}</span>`;
    }
  }
});

serviceBtn.addEventListener("click", async () => {
  initialDiv.classList.add('hidden');
  searchDiv.classList.remove('hidden');
  routeDiv.classList.remove('hidden');
  try {
    const selectedLayers = await api.getThematicLayers(selectedCollectionId, selectedFeatureId);
    apiLog.textContent = JSON.stringify(selectedLayers, null ,2);
    selectedLayerId = JSON.parse(JSON.stringify(selectedLayers)).layers[0].id;
    
  } catch (err) {
    apiLog.textContent = "Error: " + err.message;
  }
})
// Visualie button handler
document.getElementById("visualize").addEventListener("click", () => {
  if (!pendingCell || !selectedFeatureData) {
    alert("Please select a feature from the list first!");
    return;
  }

  try {
    vizStatus.textContent = "Generating 3D Model...";
    
    // 1. Clear existing model if necessary (depends on your geometry.js)
    // 2. Build the model from the stored data
    MODEL = buildBaseModel(pendingCell); 
    Plotly.react(plot3d, [], {});
    Plotly.react(plot2d, [], {});
    CURRENT_LEVEL = "__all__";
    // 3. Trigger the 3D Render
    renderAll();
    
    vizStatus.textContent = `Visualizing: ${selectedFeatureId}`;
  } catch (err) {
    console.error("Visualization Error:", err);
    vizStatus.textContent = "Error during visualization.";
  }
});
const poiBtn = document.getElementById("btn-poi");

const drawerEl = document.getElementById("results-drawer");
const drawerTitleEl = document.getElementById("drawer-title");
const drawerSubtitleEl = document.getElementById("drawer-subtitle");
const drawerFooterEl = document.getElementById("drawer-footer");
const drawerCloseBtn = document.getElementById("drawer-close");
const connectedBtn = document.getElementById("btn-connected");

let pickingRouteField = null; // "start" | "dest"
let pendingCell = null;
let selectedStartNode = null;
let selectedDestNode = null;

const startInput = document.getElementById("route-start-input");
const destInput  = document.getElementById("route-dest-input");
const navBtn = document.getElementById("btn-get-route");
const routeStatus = document.getElementById("route-status");
const vizAllBtn = document.getElementById("view-all");

function openDrawer(title, subtitle) {
  const drawer = document.getElementById("results-drawer");
  drawerTitleEl.textContent = title;
  drawerSubtitleEl.textContent = subtitle ?? "—";
  drawer.classList.remove("hidden");
  drawer.setAttribute("aria-hidden", "false");
}

function onCellResultClicked(cs, clickedBtn) {
  // highlight selected result
  document.querySelectorAll("#result-list .db-item-btn").forEach(b => b.classList.remove("active"));
  clickedBtn.classList.add("active");

  pendingCell = cs;
  viewDiv.classList.remove('hidden');
  const label = cs.cellSpaceName ?? cs.id;
  routeStatus.textContent = `Selected "${label}". Now click Start or Destination to assign.`;
}

function debounce(fn, wait = 300) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}

const nameInput  = document.getElementById("poi-name-input");
const nameStatus = document.getElementById("poi-name-status");
const runNameSearch = debounce(async () => {
  const q = nameInput.value.trim();
  if (!q) {
    nameStatus.textContent = "";
    document.getElementById("result-list").innerHTML = "";
    return;
  }

  try {
    nameStatus.textContent = "Searching...";
    openDrawer(
      pickingRouteField === "start" ? "Search CellSpace (Start)" :
      pickingRouteField === "dest"  ? "Search CellSpace (Destination)" :
      "Search CellSpace",
      `Query: "${q}"`
    );

    const result = await api.searchCellSpaceByName(selectedCollectionId, selectedFeatureId, selectedLayerId, q);

    renderCellSpaceResultsToDrawer(result);
    nameStatus.textContent = "";
    apiLog.innerText = JSON.stringify(result, null, 2);
  } catch (e) {
    nameStatus.textContent = `❌ ${e.message}`;
    apiLog.textContent = "Error: " + e.message;
  }
}, 300);

nameInput.addEventListener("input", runNameSearch);

function renderCellSpaceResultsToDrawer(poiList) {
  const resultList = document.getElementById("result-list");
  const cells = poiList?.cellSpaceMember ?? [];
  resultList.innerHTML = "";

  if (!cells.length) {
    resultList.textContent = "No results.";
    return;
  }

  drawerSubtitleEl.textContent = `${cells.length} result(s) found`;

  cells.forEach(cs => {
    const btn = document.createElement("button");
    btn.className = "db-item-btn";
    btn.innerHTML = `
      <strong>📍 ${cs.cellSpaceName ?? cs.id}</strong>
      <div class="tiny">ID: ${cs.id} | Level: ${cs.level ?? "-"}</div>
    `;

    btn.addEventListener("click", () => onCellResultClicked(cs, btn));

    resultList.appendChild(btn);
  });
}

function renderPoiToDrawer(poiList) {
  const resultList = document.getElementById("result-list");
  const cells = poiList?.cellSpaceMember ?? [];

  resultList.innerHTML = "";

  if (!cells.length) {
    resultList.textContent = "No POI cell spaces found.";
    return;
  }

  drawerSubtitleEl.textContent = `${cells.length} cell space(s) found`;

  cells.forEach(cs => {
    const btn = document.createElement("button");
    btn.className = "db-item-btn";
    btn.innerHTML = `
      <strong>📍 ${cs.cellSpaceName ?? cs.id}</strong>
      <div class="tiny">ID: ${cs.id} | Level: ${cs.level ?? "-"}</div>
    `;

    btn.addEventListener("click", () => onCellResultClicked(cs, btn));

    resultList.appendChild(btn);
  });
}

function assignPendingTo(which) {
  if (!pendingCell) {
    routeStatus.textContent = "Select a cell space from search results first.";
    return;
  }

  const label = pendingCell.cellSpaceName ?? pendingCell.id;
  selectedDualMemberId = pendingCell.duality;
  if (which === "start") {
    selectedStartNode = pendingCell.duality;
    startInput.value = label;
    routeStatus.textContent = `Start set to "${label}".`;
  } else {
    selectedDestNode = pendingCell.duality;
    destInput.value = label;
    routeStatus.textContent = `Destination set to "${label}".`;
  }

  navBtn.disabled = !(selectedStartNode && selectedDestNode);
}

startInput.addEventListener("click", () => assignPendingTo("start"));
destInput.addEventListener("click", () => assignPendingTo("dest"));

poiBtn.addEventListener("click", async () => {
  try {
    const poiList = await api.searchByPoi(selectedCollectionId, selectedFeatureId, selectedLayerId)
    // MODEL = buildBaseModel(poiList);
    // renderAll();
    openDrawer("List of Poi cell spaces", "Click a cell space");
    renderPoiToDrawer(poiList);
    apiLog.textContent = JSON.stringify(poiList, null, 2);
  } catch (err){
    apiLog.textContent = "Error: " + err.message;
  }
})


function closeDrawer(){
  if (!drawerEl) return;
  drawerEl.classList.add("hidden");
  document.getElementById("result-list").innerHTML = "";
  drawerFooterEl.textContent = "";
}
drawerCloseBtn?.addEventListener("click", closeDrawer);

const routeBtn = document.getElementById("btn-get-route");

routeBtn.addEventListener("click", async () => {
  try {
    routeResult = await api.routingQuery(selectedCollectionId, selectedFeatureId, selectedLayerId, selectedStartNode, selectedDestNode);

    apiLog.textContent = JSON.stringify(routeResult, null, 2);
    vizAllBtn.classList.remove('hidden');
  } catch (err) {
    apiLog.textContent = "Error: " + err.message;
  }
  
})

vizAllBtn.addEventListener("click", async () => {
  if (!selectedFeatureData || !routeResult) return;

  try {
    selectedFeatureDataAll = await api.getSingleFeature(selectedCollectionId, selectedFeatureId, true);
    vizStatus.textContent = "Generating 3D Model...";
    
    // 1. Clear existing model if necessary (depends on your geometry.js)
    // 2. Build the model from the stored data
    MODEL = buildBaseModel(selectedFeatureDataAll.IndoorFeatures); 
    ROUTE = buildRoute(routeResult, true);
    const { levelZ, levelSpacing } = computeLevelZ(selectedFeatureDataAll.IndoorFeatures);
    const { dualNodesByLevel, nodeLevel } = bucketDualNodesByLevel(selectedFeatureDataAll.IndoorFeatures, levelZ);
    const { dualEdgesByLevel, interLevelEdges } = bucketDualEdgesByLevel(selectedFeatureDataAll.IndoorFeatures, levelZ);
    MODEL.levelZ = levelZ;
    MODEL.levelSpacing = levelSpacing;
    MODEL.dualNodesByLevel = dualNodesByLevel;
    MODEL.dualEdgesByLevel = dualEdgesByLevel;
    MODEL.interLevelEdges = interLevelEdges;
    Plotly.react(plot3d, [], {});
    Plotly.react(plot2d, [], {});
    CURRENT_LEVEL = "__all__";
    // 3. Trigger the 3D Render
    renderAll();
    
    vizStatus.textContent = `Visualizing: ${selectedFeatureId}`;
  
  } catch (err) {
    apiLog.textContent = "Error: " + err.message;
  }
})

connectedBtn.addEventListener("click", async () => {
  try {
    connResult = await api.getConnected(selectedCollectionId, selectedFeatureId, selectedLayerId, selectedDualMemberId);
    apiLog.text = JSON.stringify(connResult, null, 2);
  } catch (err) {
    apiLog.textContent = "Error: " + err.message;
  }
})