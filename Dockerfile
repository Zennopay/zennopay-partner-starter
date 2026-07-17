# ── build stage ──────────────────────────────────────────────────────────────
FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ── runtime stage ────────────────────────────────────────────────────────────
FROM node:20-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# Secrets come from the environment (your platform's secret manager).
# Never COPY a .env file into an image.
USER node
EXPOSE 8787
CMD ["node", "dist/index.js"]
