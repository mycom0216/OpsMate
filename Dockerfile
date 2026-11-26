# Node.js 24 컨테이너에서 비루트 사용자로 실행합니다.
FROM node:24-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts && mkdir -p data && chown node:node data
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
COPY --chown=node:node manuals ./manuals
COPY --chown=node:node scripts ./scripts
USER node
ENV HOST=0.0.0.0 PORT=3100
EXPOSE 3100
CMD ["node", "src/server.js"]
