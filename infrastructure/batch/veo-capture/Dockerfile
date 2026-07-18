# Veo-capture Batch job — Node + Playwright/Chromium.
#
# Chromium is here ONLY to log in: Veo's API needs a Bearer, and the token table
# (playhub_veo_auth_tokens, 55min TTL minted every 4h) is empty ~75% of the time,
# so a job that depends on it would usually find nothing. The big transfer itself
# is a public CDN object and needs no browser and no token.
#
# The official Playwright image is used rather than the @sparticuz/chromium layer
# that src/lib/veo/auth.ts loads: that branch keys off AWS_LAMBDA_FUNCTION_NAME and
# will not fire on Fargate.
#
# No ffmpeg and no ephemeral disk: the .ts is a progressive HTTP object streamed
# straight into S3.
#
# THIS TAG AND package.json's playwright-core MUST BE THE SAME EXACT VERSION.
# The image bakes in browser binaries under a version-stamped path
# (/ms-playwright/chromium_headless_shell-<rev>/), and playwright-core only looks
# for its own revision. A caret range is enough to break it: `^1.58.2` resolved to
# 1.61.1 on the first build and every launch died with
# "Executable doesn't exist at /ms-playwright/chromium_headless_shell-1228/...".
# Bump both together or not at all.
FROM mcr.microsoft.com/playwright:v1.58.2-noble

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
# Glob, not a name list: entrypoint.mjs imports sibling modules, and a COPY that
# names files individually is one more place to drift out of lockstep — the job
# would build clean and then ERR_MODULE_NOT_FOUND at runtime, on Fargate, after
# the sweep already claimed the row.
COPY *.mjs ./

CMD ["node", "entrypoint.mjs"]
