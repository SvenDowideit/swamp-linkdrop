#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if [ -f keystore/linkdrop.jks ] && [ -f keystore.properties ]; then
    echo "Keystore already exists: keystore/linkdrop.jks"
    exit 0
fi

mkdir -p keystore
PASS="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"

docker run --rm \
    -v "$PWD/keystore":/keystore \
    linkdrop-builder \
    keytool -genkeypair -v \
    -storetype PKCS12 \
    -keystore /keystore/linkdrop.jks \
    -alias linkdrop \
    -keyalg RSA \
    -keysize 2048 \
    -validity 10000 \
    -storepass "$PASS" \
    -keypass "$PASS" \
    -dname "CN=LinkDrop, OU=Personal, O=LinkDrop, C=AU"

cat > keystore.properties <<EOF
storeFile=keystore/linkdrop.jks
storePassword=$PASS
keyAlias=linkdrop
keyPassword=$PASS
EOF

chmod 600 keystore.properties
echo "Generated keystore/linkdrop.jks and keystore.properties"
echo "Back up both files. The same signing key is required for updates."
