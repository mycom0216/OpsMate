# Node.js 24 컨테이너에서 비루트 사용자로 실행합니다.
# 실행 및 테스트 기준과 같은 Node.js 24 계열을 사용합니다.
FROM node:24-bookworm-slim
WORKDIR /app
# 의존성 잠금 파일을 먼저 복사하여 소스가 바뀌어도 설치 레이어를 재사용할 수 있게 합니다.
COPY package*.json ./
# 잠금 파일대로 런타임 의존성만 설치하고 데이터 폴더의 쓰기 권한을 node 사용자에게 줍니다.
RUN npm ci --omit=dev --ignore-scripts && mkdir -p data && chown node:node data
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
COPY --chown=node:node manuals ./manuals
COPY --chown=node:node scripts ./scripts
# 앱 프로세스를 root 권한으로 실행하지 않습니다. 앱 코드는 앞에서 node 소유로 복사합니다.
USER node
# 컨테이너 내부에서는 모든 인터페이스에 바인딩합니다. 호스트 공개 범위는 compose의 ports가 정합니다.
ENV HOST=0.0.0.0 PORT=3100
EXPOSE 3100
# 셸 문자열을 조합하지 않고 인자 배열로 서버를 직접 실행합니다.
CMD ["node", "src/server.js"]
