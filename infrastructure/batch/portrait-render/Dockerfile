# Portrait-render Batch job — Node 22, no system deps (Modal does the ffmpeg
# work; this container orchestrates: DB reads, clip fetch, Modal calls,
# storage upload). dist/entrypoint.mjs is built LOCALLY with esbuild (it
# bundles src/lib/editor via relative imports) and shipped in the source zip —
# the image build never needs the repo.
FROM node:22-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY dist/entrypoint.mjs ./

RUN useradd -r -u 10001 portrait
USER portrait

CMD ["node", "entrypoint.mjs"]
