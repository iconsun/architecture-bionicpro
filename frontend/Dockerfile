# ---------- build stage ----------
FROM node:20-alpine AS build
WORKDIR /app

# deps
COPY package.json package-lock.json ./
RUN npm ci

# sources
COPY . .

# fix CRLF + exec bits в .bin и собираем
RUN apk add --no-cache dos2unix \
 && find node_modules/.bin -type f -exec dos2unix {} + \
 && chmod +x node_modules/.bin/* \
 && node node_modules/react-scripts/bin/react-scripts.js build

# ---------- runtime stage ----------
FROM nginx:alpine
WORKDIR /usr/share/nginx/html
COPY --from=build /app/build ./
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
# Явно: базовый образ и так это делает, но оставим для прозрачности
CMD ["nginx", "-g", "daemon off;"]
