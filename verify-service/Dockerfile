FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY server.mjs ./
ENV PORT=8080
EXPOSE 8080
CMD ["node", "--max-old-space-size=1024", "server.mjs"]
