name:=europe-west3-docker.pkg.dev/precisely-production/services/jackson
tag:=$(shell git describe --always)

default: docker

all: docker-push

.PHONY: docker
docker:
	docker build -t $(name):$(tag) -t $(name):latest .

.PHONY: docker-push
docker-push: docker
	docker push $(name):$(tag)
	docker push $(name):latest
