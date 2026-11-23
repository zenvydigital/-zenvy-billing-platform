# syntax=docker/dockerfile:1
# Zenvy Digitals Billing Platform — portable image.
# Same image runs on Render (Docker web service) and later on a DigitalOcean
# Droplet (docker run). No host-specific code inside the app; all config
# comes from environment variables (see .env.example).
FROM node:20-alpine

WORKDIR /app

# Install dependencies first (better layer caching).
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

# App code (migrations, server, public placeholder page).
COPY src ./src
COPY db ./db
COPY public ./public

# Run as a non-root user.
RUN addgroup -S app && adduser -S app -G app \
  && chown -R app:app /app
USER app

# Render and Docker both set PORT at runtime; default 3000 locally.
ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" || exit 1

CMD ["node", "src/index.js"]
