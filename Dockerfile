FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
CMD ["npx", "tsx", "server/index.ts", "--production"]
