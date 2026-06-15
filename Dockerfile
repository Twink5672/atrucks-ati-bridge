FROM node:22-slim

WORKDIR /app

COPY package.json ./
COPY src ./src

# Директория для SQLite (Railway volume монтируется сюда)
RUN mkdir -p /data

ENV DB_PATH=/data/atrucks-ati.sqlite
ENV NODE_OPTIONS=--no-warnings

EXPOSE 3000

CMD ["node", "src/index.js"]
