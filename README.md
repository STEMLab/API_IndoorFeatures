# API-IndoorFeatures

API - IndoorFeatures is a RESTful api implementation of the **OGC IndoorGML 2.0** standard, designed to align with **OGC API - Features** standards. This api extends the pygeoapi framework to provide specialized service layers for indoor environments.
- We are working on `branch_for_indoorAPI` [branch](https://github.com/STEMLab/API_IndoorFeatures/tree/branch_for_indoorAPI).

### Naming

This API is referred to as the **API-IndoorFeatures** because it implements
the IndoorGML 2.0 conceptual model, including spatial subdivision, topology,
layering, and duality relationships.

All resources are exchanged using **IndoorJSON**, which serves as the
concrete JSON encoding of IndoorGML concepts.

---

## 🚀 Project Overview

This project is a extension of 
[pygeoapi](https://pygeoapi.io), designed to provide a RESTful API for IndoorGML 2.0 standard.


---

## 🛠 Technical Pedigree

### Built on [pygeoapi](https://pygeoapi.io)
This engine is built upon a specialized fork of **pygeoapi 0.22.0**, a Python server implementation of the OGC API suite of standards. 
* **Standardized Access:** Provides RESTful endpoints using OpenAPI, JSON, and HTML.
* **Extended Core:** We have customized the `api/indoorgml.py` core and developed custom providers `provider/postgresql_indoordb.py` to handle the unique hierarchy structure of `IndoorFeatures`.
* **PostgreSQL/PostGIS:** Optimized schema of indoor DB for efficient query and geometric functions.
* **pgRouting:** Routing the optimal path in the graph(DualSpace).
* **Dockerized:** Fully containerized environment for immediate deployment.

---

## 🛰 API Service Architecture

| Category | Endpoint | Description |
| :--- | :--- | :--- |
| **Core** | `/collections/{collection_id}/items/{feature_id}` | Standard OGC resource discovery and Feature access. |
| **IndoorFeature** | `.../layers/{layer_id}/` | Specialized access to IndoorJSON `ThematicLayer`. |
| **IndoorFeature** | `.../interlayerconnections/{connection_id}/` | Specialized access to IndoorJSON `interLayerConnection`. |
| **IndoorFeature** | `.../primal/{member_id}/...` | Specialized access to IndoorJSON primal space components (`cellSpace` and `cellBoundary`). |
| **IndoorFeature** | `.../dual/{member_id}/...` | Specialized access to IndoorJSON dual space components (`node` and `edge`). |
| **Services** | `...{layer_id}/routing` | Shortest path calculation powered by pgRouting.|
| **Services** | `/geoquery` | Advanced spatial filtering via WKT-form 2D geometries. |

💡 Tip: For a full list of over 20+ endpoints, including detailed parameter schemas and CRUD operations, please refer to our interactive documentation at:
🔗 Swagger UI: `/openapi`.

---

## 📥 Installation & Setup
### 1. Prerequisites
* Docker & Docker Compose (For PostGIS/pgRouting)
* Python 3.10+ (For pygeoapi)

### 2. Environment Startup
We recommend using a Python virtual environment to manage dependencies and avoid conflicts with system-level packages.
```bash
# Clone the repository
git clone [https://github.com/STEMLab/API-IndoorFeatures.git](https://github.com/STEMLab/API-IndoorFeatures.git)
cd API-IndoorFeatures

# Create and activate a Python Virtual Environment
python3 -m venv .venv
source venv/bin/activate

# Install required dependencies
pip install -r requirements-indoorfeature.txt
pip install -e .

# Start Docker Containers
docker-compose up -d --build

bash ./start.sh
```

### 3. Testing api
We recommand to use a swagger UI for testing api.

