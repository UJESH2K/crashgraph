# crashgraph as one container: FalkorDB, the trainer, the API and the console, on one port.
#
# The console is exported to a static site and served by the Python process, so there is no
# second host, no CORS to configure, no build-time API URL and no mixed-content problem. The
# browser talks to whatever origin served the page.
#
#   docker build -t crashgraph .
#   docker run -p 8000:8000 crashgraph          ->  http://localhost:8000
#
# On Render: a Docker web service, no start command needed. It listens on $PORT.

# ── 1. the console, as a static site ────────────────────────────────────────
FROM node:20-bookworm-slim AS console
WORKDIR /console
COPY web-next/package.json web-next/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web-next/ ./
# No API origin is baked in: the export resolves it from window.location at runtime.
ENV CRASHGRAPH_EXPORT=1
RUN npm run build


# ── 2. FalkorDB, Python, and the app ────────────────────────────────────────
# The FalkorDB image already carries redis with the graph module built for it, which is the
# part that is genuinely awkward to assemble by hand. Python goes on top.
FROM falkordb/falkordb:latest

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

# swig and a compiler are here for Box2D, which has no wheel for every interpreter and falls
# back to building from source.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl build-essential swig \
 && rm -rf /var/lib/apt/lists/*

# uv brings its own CPython, so the image does not inherit whatever Debian happens to ship —
# Box2D and Gymnasium are fussier about the interpreter than the rest of the stack. It goes
# into a venv rather than the interpreter itself, which uv marks externally managed.
COPY --from=ghcr.io/astral-sh/uv:0.5.11 /uv /usr/local/bin/uv
RUN uv venv --python 3.12 /opt/venv
ENV VIRTUAL_ENV=/opt/venv \
    PATH=/opt/venv/bin:$PATH

WORKDIR /app
COPY requirements.txt ./
RUN uv pip install --python /opt/venv/bin/python -r requirements.txt \
 && python -c "import gymnasium, Box2D, numpy, falkordb, fastapi; print('deps ok')"

COPY crashgraph/ ./crashgraph/
COPY web/ ./web/
# The vanilla console at /classic wants the same three models the Next one does. They are
# committed once, under web-next/public/assets, and copied across here rather than stored twice.
COPY web-next/public/assets/ ./web/assets/
COPY server.py train.py removal_test.py mcp_server.py ./
COPY --from=console /console/out ./web-next/out
COPY deploy/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Where the graph lives. Mount a volume here to keep a trained memory across deploys; without
# one the container starts from an empty graph and learns from scratch, which is a perfectly
# good demonstration of the thing being demonstrated.
ENV CRASHGRAPH_DATA=/data \
    FALKORDB_URL=redis://127.0.0.1:6379 \
    HOST=0.0.0.0 \
    PORT=8000
VOLUME ["/data"]

EXPOSE 8000
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
