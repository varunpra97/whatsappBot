FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY src ./src
COPY config.example.json ./
ENV BOT_CONFIG=/app/state/config.json BOT_DATA_DIR=/app/state/data BOT_AUTH_DIR=/app/state/auth
VOLUME /app/state
CMD ["node", "src/index.js"]
