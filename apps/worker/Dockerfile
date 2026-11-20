FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/scheduler/package.json apps/scheduler/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/server/package.json packages/server/package.json
RUN npm ci
COPY . .
HEALTHCHECK --interval=10s --timeout=5s --retries=10 CMD node -e "const fs=require('fs'); const t=Number(fs.readFileSync('/tmp/taskflow-worker-alive','utf8')); process.exit(Date.now()-t<20000?0:1)"
CMD ["npx", "tsx", "apps/worker/src/index.ts"]
