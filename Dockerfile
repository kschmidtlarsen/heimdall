FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force

COPY --from=builder /app/dist ./dist

# Default config baked into the image. Override by mounting your own at /etc/heimdall/config.yml.
COPY config.example.yml /etc/heimdall/config.yml

ENV NODE_ENV=production
ENV PORT=8080
ENV HOST=0.0.0.0
ENV CONFIG_PATH=/etc/heimdall/config.yml

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/health || exit 1

CMD ["node", "dist/index.js"]
