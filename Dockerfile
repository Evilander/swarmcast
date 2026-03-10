FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY public ./public
COPY src ./src
COPY README.md ./

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3777
ENV REQUIRE_LLM_KEY=true

EXPOSE 3777

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3777) + '/api/ready').then((res) => process.exit(res.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["npm", "run", "start:prod"]
