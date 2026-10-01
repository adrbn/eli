# Eli on a home server: same server, Linux edition. Builds natively on amd64 and arm64
# (or both at once: docker buildx build --platform linux/amd64,linux/arm64 .).
FROM python:3.12-slim-bookworm AS build
COPY --from=ghcr.io/astral-sh/uv:0.12 /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_NO_CACHE=1 UV_PYTHON_DOWNLOADS=never
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --locked --no-dev --no-install-project

FROM python:3.12-slim-bookworm
# ffmpeg: music decoding and the MP3 fallback. curl: first-start model downloads.
# libstdc++6/libatomic1: needed by the onnxruntime and vosk wheels, not guaranteed in the slim image.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg curl libstdc++6 libatomic1 \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --uid 1000 --create-home eli
WORKDIR /app
COPY --from=build /app/.venv /app/.venv
COPY server server
COPY web web
COPY deploy/entrypoint.sh deploy/entrypoint.sh
RUN mkdir voices memory cache local && chown eli:eli voices memory cache local
ENV PATH=/app/.venv/bin:$PATH PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 HOST=0.0.0.0 PORT=5280
USER eli
EXPOSE 5280
# Long start period: the first start downloads ~130 MB of models before the server comes up.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5m --retries=3 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:5280/api/status', timeout=4)"]
ENTRYPOINT ["/app/deploy/entrypoint.sh"]
CMD ["python", "server/app.py"]
