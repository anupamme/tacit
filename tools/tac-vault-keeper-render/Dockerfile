# Render image for the TAC vault keeper (tools/tac-vault-keeper.mjs): a Node process that shells out to Foundry's `cast`.
# Build context is the repository root:  docker build -f tools/tac-vault-keeper-render/Dockerfile .
FROM node:20-bookworm-slim
ARG FOUNDRY_VERSION=v1.3.5
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates git \
 && rm -rf /var/lib/apt/lists/* \
 && curl -fsSL "https://github.com/foundry-rs/foundry/releases/download/${FOUNDRY_VERSION}/foundry_${FOUNDRY_VERSION}_linux_$(dpkg --print-architecture).tar.gz" | tar -xz -C /usr/local/bin cast \
 && cast --version
COPY tools/tac-vault-keeper.mjs ./tools/tac-vault-keeper.mjs
COPY tools/tac-vault-keeper-render/start.sh ./start.sh
RUN chmod +x ./start.sh
CMD ["./start.sh"]
