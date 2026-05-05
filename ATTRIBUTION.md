# ATTRIBUTION.md — Open-Source Credits

RefereeOS builds on the following open-source projects and APIs. We are grateful to their maintainers and communities.

## Core Frameworks

| Project | License | Usage in RefereeOS | Link |
|---------|---------|-------------------|------|
| **AG2** | Apache 2.0 | Multi-agent orchestration framework; powers the area-chair synthesis with `autogen.beta.Agent` | https://github.com/ag2ai/ag2 |
| **Daytona** | Apache 2.0 | Sandboxed code execution for reproducibility probes | https://github.com/daytonaio/daytona |
| **FastAPI** | MIT | Backend API framework | https://github.com/fastapi/fastapi |
| **Uvicorn** | BSD | ASGI server | https://github.com/encode/uvicorn |
| **PyMuPDF** | AGPL / Commercial | PDF text extraction | https://github.com/pymupdf/PyMuPDF |
| **Pydantic** | MIT | Data validation and settings management | https://github.com/pydantic/pydantic |
| **python-dotenv** | BSD | Environment variable loading | https://github.com/theskumar/python-dotenv |
| **python-multipart** | Apache 2.0 | Multipart form data parsing | https://github.com/Kludex/python-multipart |

## Frontend

| Project | License | Usage in RefereeOS | Link |
|---------|---------|-------------------|------|
| **React** | MIT | UI framework | https://github.com/facebook/react |
| **Vite** | MIT | Build tool and dev server | https://github.com/vitejs/vite |
| **TypeScript** | Apache 2.0 | Type-safe JavaScript | https://github.com/microsoft/TypeScript |
| **Lucide** | ISC | Icon library | https://github.com/lucide-icons/lucide |

## External APIs

| Service | Usage in RefereeOS | Link |
|---------|-------------------|------|
| **Semantic Scholar** | Live paper search for related-work discovery | https://www.semanticscholar.org/product/api |
| **DeepSeek API** | Lead model for AG2 area-chair synthesis | https://api.deepseek.com |
| **Kimi (Moonshot) API** | Cross-model critic for adversarial review | https://api.moonshot.cn |
| **Zhipu (BigModel) API** | Final synthesis scorer | https://open.bigmodel.cn |

## Design Paradigm

| Source | Concept | Link |
|--------|---------|------|
| **OpenAI** | Harness Engineering — the paradigm of building deterministic engineering infrastructure around probabilistic models | https://openai.com |

## Development Tools

| Tool | Usage | Link |
|------|-------|------|
| **Claude Code** | AI-assisted development environment | https://claude.ai/code |

---

All trademarks and copyrights are property of their respective owners. RefereeOS is an independent project and is not affiliated with or endorsed by any of the above organizations.
