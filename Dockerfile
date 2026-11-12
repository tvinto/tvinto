# The backend, built to run somewhere that is not this machine.
#
# The context is the repository root rather than backend/, because the backend
# imports the shared xtream code from ../shared and a build that cannot see it
# has nothing to compile.

# --- dependencies ---------------------------------------------------------
# better-sqlite3 is a native module. Prebuilt binaries exist for common
# platforms, but not for all of them, and an image that can compile it works
# everywhere rather than only where a prebuild happened to be published --
# which matters here because the likely hosts are ARM.
FROM node:24-bookworm-slim AS deps
WORKDIR /app/backend
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY backend/package.json backend/package-lock.json ./
RUN npm ci

# --- build ----------------------------------------------------------------
FROM deps AS build
WORKDIR /app
COPY shared ./shared
COPY backend/tsconfig.json ./backend/
COPY backend/src ./backend/src
RUN cd backend && npx tsc

# --- runtime dependencies -------------------------------------------------
# Installed separately so the image carries no compilers and no dev
# dependencies, only what the server actually loads.
FROM node:24-bookworm-slim AS runtime-deps
WORKDIR /app/backend
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev

# --- the image ------------------------------------------------------------
FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app/backend

COPY --from=runtime-deps /app/backend/node_modules ./node_modules
COPY --from=build /app/backend/dist ./dist
COPY backend/package.json ./

# The database belongs on a volume, not in the image: everything the app has
# been told -- accounts, subscriptions, favourites, history -- lives in it, and
# a deploy replaces the image. DATABASE_PATH must point inside this.
VOLUME ["/data"]
ENV DATABASE_PATH=/data/xtream-cache.db

# Not root, because this answers the internet. The volume is chowned at build
# time; a host-mounted directory needs the same ownership on the host side.
RUN mkdir -p /data && chown -R node:node /data
USER node

EXPOSE 3000
ENV PORT=3000

# tsconfig has rootDir ../, so the compiled tree keeps the repository's shape.
CMD ["node", "dist/backend/src/server.js"]
