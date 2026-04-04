.PHONY: install dev build lint clean env

install:
	npm ci

dev:
	npm run dev

build:
	npm run build

lint:
	npm run lint

clean:
	rm -rf .next


