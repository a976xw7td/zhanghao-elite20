from __future__ import annotations

import os


try:
    from dotenv import load_dotenv

    load_dotenv(".env")
    load_dotenv(".env.local", override=True)
    load_dotenv(".local.env", override=True)
except Exception:
    pass


def main() -> int:
    """Launch the RefereeOS API."""
    import uvicorn

    host = os.getenv("REFEREEOS_HOST", "127.0.0.1")
    port = int(os.getenv("REFEREEOS_PORT", "8000"))
    reload = os.getenv("REFEREEOS_RELOAD", "false").lower() == "true"
    uvicorn.run(
        "backend.app:app",
        host=host,
        port=port,
        reload=reload,
        reload_excludes=["outputs/*"] if reload else [],
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
