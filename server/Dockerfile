# 构建：docker build -t xynote-sync-server server/
# 运行：docker run -d -p 8787:8787 -v xynote-data:/data xynote-sync-server
FROM rust:1-bookworm AS build
WORKDIR /src
COPY . .
RUN cargo build --release --locked

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/target/release/xynote-sync-server /usr/local/bin/xynote-sync-server
ENV XYNOTE_BIND=0.0.0.0:8787 XYNOTE_DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 8787
CMD ["xynote-sync-server"]
