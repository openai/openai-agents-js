FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates fuse3 rclone \
  && rm -rf /var/lib/apt/lists/*
