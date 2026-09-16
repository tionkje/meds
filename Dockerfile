FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production TZ=Europe/Brussels DATABASE_PATH=/app/data/meds.db PORT=3000
COPY server.ts index.html sw.js manifest.json icon.svg ./
EXPOSE 3000
CMD ["node", "server.ts"]
