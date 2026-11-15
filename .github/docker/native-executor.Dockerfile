FROM docker.io/library/python:3.14-slim@sha256:a2b82f3c48559aa0a8446d9af49826b6e2b2016f4cd2afabfe6013ec53729170

RUN apt-get update \
    && apt-get install --yes --no-install-recommends bubblewrap \
    && rm -rf /var/lib/apt/lists/*
