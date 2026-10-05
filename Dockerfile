# APEX AI backend — production image. Runs on any container host that terminates HTTPS in front of it
# (Cloud Run, Fly.io, Render, Railway, ECS…). Secrets come from the host's environment, never the image.
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY backend ./backend
COPY src ./src
COPY supabase ./supabase
RUN node backend/build.mjs

FROM node:24-alpine
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787
WORKDIR /srv
COPY --from=build /app/build/server ./
RUN npm install --omit=dev --no-audit --no-fund --ignore-scripts && npm cache clean --force
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" || exit 1
CMD ["node", "backend/server.js"]
