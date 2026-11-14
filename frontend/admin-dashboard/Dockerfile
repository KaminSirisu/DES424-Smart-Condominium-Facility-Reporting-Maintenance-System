FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/liff-app/package.json frontend/liff-app/package.json
COPY frontend/admin-dashboard/package.json frontend/admin-dashboard/package.json
RUN npm ci --workspace @scfrms/admin-dashboard --include-workspace-root

COPY tsconfig.base.json ./
COPY frontend/admin-dashboard frontend/admin-dashboard
ARG VITE_API_BASE_URL
RUN test -n "$VITE_API_BASE_URL" && npm run build --workspace @scfrms/admin-dashboard

FROM nginx:stable-alpine
COPY frontend/admin-dashboard/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/frontend/admin-dashboard/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
