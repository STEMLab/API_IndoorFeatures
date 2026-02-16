# IndoorGML API

IndoorGML api is a RESTful api implementation of the **OGC IndoorGML 2.0** standard, designed to align with **OGC API - Features** standards. This api extends the pygeoapi framework to provide specialized service layers for indoor environments.


### Naming

This API is referred to as the **IndoorGML API** because it implements
the IndoorGML conceptual model, including spatial subdivision, topology,
layering, and duality relationships.

All resources are exchanged using **IndoorJSON**, which serves as the
concrete JSON encoding of IndoorGML concepts.

---

## 🚀 Project Overview

This project is a extension of 
[pygeoapi](https://pygeoapi.io), designed to provide a RESTful API for IndoorGML 2.0 standard.
### Key Accomplishments
* **OGC Standards Alignment:** Successfully mapped IndoorGML 2.0 Indoorfeature to the OGC API - Features core.
* **Dual-Space Logic:** Full implementation of Primal Space and Dual Space connectivity via. Poincare's Duality.
* **Advanced Navigation:** Custom service endpoints for Shortest Path (Dijkstra) and Topological N-Hop analysis.
* **Engineering Precision:** Native support for **SRID 0** (Cartesian Plane) for building-scale accuracy.

---

## 🛠 Technical Pedigree

### Built on [pygeoapi](https://pygeoapi.io)
This engine is built upon a specialized fork of **pygeoapi**, a Python server implementation of the OGC API suite of standards. 
* **Standardized Access:** Provides RESTful endpoints using OpenAPI, GeoJSON, and HTML.
* **Extended Core:** We have customized the `api/indoorgml.py` core and developed custom providers to handle the unique hierarchy of `IndoorFeatures`.
* **PostgreSQL/PostGIS:** Optimized schema for spatial bounding and geometric queries.
* **pgRouting:** Dynamic graph traversal without the overhead of static topology creation.
* **Dockerized:** Fully containerized environment for immediate deployment.

---

## 🛰 API Service Architecture

| Category | Endpoint | Description |
| :--- | :--- | :--- |
| **Core** | `/collections/{collection_id}/items/{feature_id}` | Standard OGC resource discovery and Feature access. |
| **IndoorFeature** | `.../layers/{layer_id}/...` | Specialized access to IndoorJSON components (Thematic layers). |
| **Navigation** | `...{layer_id}/routing` | Shortest path calculation powered by pgRouting.|
| **Spatial** | `/geoquery` | Advanced spatial filtering via WKT-form 2D geometries. |

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
git clone [https://github.com/STEMLab/IndoorGML_API.git](https://github.com/STEMLab/IndoorGML_API.git)
cd IndoorGML_API
# Create and activate a Python Virtual Environment
python3 -m venv venv
source venv/bin/activate
# Install required dependencies
pip install -r requirements-indoor.txt
pip install -e .
# Start Docker Containers
docker-compose up -d --build
export PYGEOAPI_CONFIG=pygeoapi-config.yml
export PYGEOAPI_OPENAPI=openAPI/indoorgmlapi_bundled.yml

pygeoapi serve
```

### 2. Environment Startup
We recommand to use a swagger UI for testing api.

