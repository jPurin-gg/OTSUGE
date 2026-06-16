FROM alpine:3.21
RUN apk add --no-cache curl tzdata
WORKDIR /scheduler
COPY crontab /etc/crontabs/root
COPY run-dispatch.sh run-generate.sh ./
RUN chmod +x run-dispatch.sh run-generate.sh
CMD ["crond", "-f", "-l", "8"]
