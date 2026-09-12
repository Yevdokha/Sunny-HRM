FROM node:20-bookworm-slim
WORKDIR /app
# bcrypt build tools + LibreOffice for safe server-side previews of office files.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ libreoffice-writer libreoffice-calc libreoffice-impress \
    fonts-dejavu-core ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY package.json ./
RUN npm install --omit=dev
COPY src ./src
COPY migrations ./migrations
ENV NODE_ENV=production
ENV HOME=/tmp
EXPOSE 3000
CMD ["node", "src/server.js"]
