# FS Assistant — Strands TS multi-agent on Bedrock AgentCore Runtime.
#
# AgentCore Runtime requires linux/arm64 images and the HTTP contract:
#   GET  /ping        → 200 {status:"Healthy"}
#   POST /invocations → AgentCore-issued binary payload, JSON response
# Doc: https://strandsagents.com/docs/user-guide/deploy/deploy_to_bedrock_agentcore/typescript/
#
# IMPORTANT: build context is the **repo root** so we can preserve the
# `agents/fs-assistant/` ↔ `lambda/...` layout the source's relative
# imports rely on (e.g. `../../../../../lambda/chat/tools`). Build with:
#
#   docker build -f agents/fs-assistant/Dockerfile -t fs-assistant .
#
FROM --platform=linux/arm64 public.ecr.aws/docker/library/node:20

# Mirror the host repo layout so relative imports resolve identically.
WORKDIR /repo/agents/fs-assistant

# Bring in the agent's package manifest first so npm install can cache.
COPY agents/fs-assistant/package.json agents/fs-assistant/tsconfig.json ./
RUN npm install

# Install the lambda tree's deps in /repo/lambda/node_modules. Each
# lambda source file (`lambda/chat/tools/*.ts`, `lambda/gmail-analysis/*.ts`,
# `lambda/shared/*.ts`) imports `@aws-sdk/*` packages by name, and Node's
# module resolution walks up from the file's directory — without
# `/repo/lambda/node_modules` it never finds the agent's own
# `node_modules` siblings.
WORKDIR /repo/lambda
COPY lambda/package.json lambda/package-lock.json ./
RUN npm install --omit=dev

# Switch back to the agent workdir for the rest of the build.
WORKDIR /repo/agents/fs-assistant

# Copy the agent source.
COPY agents/fs-assistant/src ./src

# Copy the shared lambda modules our agent imports from. Preserves the
# `agents/fs-assistant/src/.../` ↔ `lambda/.../` relative path the
# tsconfig and the imports both depend on.
COPY lambda/shared /repo/lambda/shared
COPY lambda/chat/tools /repo/lambda/chat/tools
COPY lambda/chat/helpers.ts /repo/lambda/chat/helpers.ts
COPY lambda/gmail-analysis/tools /repo/lambda/gmail-analysis/tools
COPY lambda/gmail-analysis/cache.ts /repo/lambda/gmail-analysis/cache.ts
COPY lambda/gmail /repo/lambda/gmail

# Compile. tsc emits to `dist/` mirroring the input tree depth, so the
# entry point ends up at dist/agents/fs-assistant/src/server.js.
RUN npm run build

EXPOSE 8080

CMD ["node", "dist/agents/fs-assistant/src/server.js"]
