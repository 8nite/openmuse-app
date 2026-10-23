FROM mcr.microsoft.com/playwright:v1.62.1-noble
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && mkdir /data && chown pwuser:pwuser /data /app
# Headed stock Chromium under Xvfb reads as a real desktop browser
# (compositor, media, timers, fonts) instead of headless shell. The agent
# still gets no in-page JS, only the fixed screenshot/text/click/key/scroll
# channel. Branded Chrome is deliberately not installed: it was measured
# phoning home to Google on every launch, conflicting with the worker's
# no-unexpected-egress posture.
RUN apt-get update && apt-get install -y --no-install-recommends xvfb fonts-liberation \
  && rm -rf /var/lib/apt/lists/*
COPY --chown=pwuser:pwuser src ./src
USER pwuser
ENV NODE_ENV=production WORKER_DATA_DIR=/data WORKER_HOST=0.0.0.0
EXPOSE 8790
CMD ["xvfb-run", "-a", "-s", "-screen 0 1280x800x24", "node", "--experimental-strip-types", "src/index.ts"]
