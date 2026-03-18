import argparse
import multiprocessing
import os

import uvicorn

from easyeda2kicad.api.server import create_app


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default=os.getenv("HOST", "0.0.0.0"))
    parser.add_argument("--port", type=int, default=int(os.getenv("PORT", "8087")))
    args = parser.parse_args()

    app = create_app()

    uvicorn.run(
        app,
        host=args.host,
        port=args.port,
        loop="asyncio",
        http="h11",
        reload=False,
        workers=1,
    )


if __name__ == "__main__":
    multiprocessing.freeze_support()
    main()
