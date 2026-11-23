# sky's iMessage bridge: upstream mautrix-imessage + full-history.patch.
FROM golang:1-alpine3.24 AS builder
RUN apk add --no-cache git ca-certificates build-base olm-dev
COPY . /build
WORKDIR /build
RUN go build -o mautrix-imessage .

FROM alpine:3.24
ENV UID=1337 GID=1337
RUN apk add --no-cache ffmpeg su-exec ca-certificates bash jq curl yq-go olm
COPY --from=builder /build/mautrix-imessage /usr/bin/mautrix-imessage
COPY --from=builder /build/example-config.yaml /opt/mautrix-imessage/example-config.yaml
COPY --from=builder /build/docker-run.sh /docker-run.sh
VOLUME /data
CMD ["/docker-run.sh"]
