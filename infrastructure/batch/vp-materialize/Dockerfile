# VP-materialize Batch job — Node 22 + ffmpeg. Remuxes a recording's raw
# VirtualPanorama HLS (VOD, multi-GB 4K) into an mp4 in our private S3.
FROM node:22-slim

# ffmpeg for the HLS→mp4 remux (-c copy, no re-encode). ca-certificates for the
# HTTPS fetches to Spiideo + S3.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY entrypoint.mjs ./

ENV FFMPEG_PATH=ffmpeg
CMD ["node", "entrypoint.mjs"]
