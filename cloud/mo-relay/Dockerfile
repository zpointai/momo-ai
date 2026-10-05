FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY gateway.mjs server.mjs admin.mjs voice.mjs ./
ENV NODE_ENV=production PORT=8080 DATABASE_PATH=/data/relay.sqlite
EXPOSE 8080
CMD ["node", "server.mjs"]
