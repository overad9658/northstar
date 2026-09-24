#!/bin/sh

set -eu

PROJECT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
OUTPUT_DIR="$PROJECT_DIR/.sbom"
IMAGE_REF=${IMAGE_REF:-northstar-priority-matrix:sbom}
TRIVY_IMAGE=${TRIVY_IMAGE:-aquasec/trivy:0.74.0}
TRIVY_CACHE_VOLUME=${TRIVY_CACHE_VOLUME:-northstar-trivy-cache}

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required to generate the SBOM." >&2
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "Docker is installed, but its engine is not available. Start Docker and try again." >&2
  exit 1
fi

mkdir -p "$OUTPUT_DIR"

echo "Building $IMAGE_REF..."
docker build --tag "$IMAGE_REF" "$PROJECT_DIR"

run_trivy() {
  docker run --rm \
    --volume /var/run/docker.sock:/var/run/docker.sock \
    --volume "$TRIVY_CACHE_VOLUME:/root/.cache/" \
    --volume "$OUTPUT_DIR:/output" \
    "$TRIVY_IMAGE" "$@"
}

echo "Generating CycloneDX SBOM..."
run_trivy image \
  --format cyclonedx \
  --output /output/northstar.cdx.json \
  "$IMAGE_REF"

echo "Scanning packages for known vulnerabilities..."
run_trivy image \
  --scanners vuln \
  --format json \
  --output /output/vulnerabilities.json \
  "$IMAGE_REF"
run_trivy image \
  --scanners vuln \
  --format table \
  --output /output/vulnerabilities.txt \
  "$IMAGE_REF"

echo
echo "Vulnerability report:"
cat "$OUTPUT_DIR/vulnerabilities.txt"
echo
echo "Reports written to $OUTPUT_DIR"
