from __future__ import annotations

import uvicorn

from motionbridge.server import create_app


if __name__ == "__main__":
    uvicorn.run(create_app(enable_outputs=False), host="127.0.0.1", port=8876, log_level="warning")
